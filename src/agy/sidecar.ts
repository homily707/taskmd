import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TaskFiles } from '../core/files.js';
import { TaskError, type CreateTaskInput, type HomeSettings, type TaskChanges } from '../types.js';
import { startCdpComposerBridge } from './cdp-composer.js';
import { createConversationServiceClient, type ConversationServiceClient } from './ls.js';

export interface SidecarResponseLike {
  body: string | Uint8Array;
  contentType: string;
  status: number;
}

export interface SidecarAppLike {
  page(path: string, handler: () => SidecarResponseLike | Promise<SidecarResponseLike> | string | Promise<string>): void;
  api(path: string, handler: (data: Record<string, unknown>) => unknown | Promise<unknown>, method?: string): void;
  run(): Promise<unknown>;
  close(): Promise<void>;
}

export interface TaskmdSidecarOptions {
  files: TaskFiles;
  ls: ConversationServiceClient;
  projectId?: string;
  readAsset?: (relativePath: string) => Buffer | string;
}

function errorPayload(error: unknown): SidecarResponseLike {
  if (error instanceof TaskError) {
    const status = error.code === 'version_conflict' ? 409
      : error.code === 'not_found' ? 404
        : 400;
    return {
      status,
      contentType: 'application/json',
      body: JSON.stringify({ error: error.message, code: error.code, details: error.details }),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: message }),
  };
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TaskError('invalid_request', `${field} is required.`);
  }
  return value.trim();
}

function renderIndexHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Taskmd</title>
  <style>
    html, body, #root {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div id="root"><p style="padding:12px;font:13px/1.5 sans-serif;opacity:0.7">Loading Taskmd…</p></div>
  <script>
    window.addEventListener('error', function (event) {
      var root = document.getElementById('root');
      if (root && !root.dataset.mounted) {
        root.innerHTML = '<pre style="padding:12px;color:#d0453b;white-space:pre-wrap;font:12px/1.5 monospace">' +
          String(event.message || event.error || 'Unknown error') + '</pre>';
      }
    });
  </script>
  <script src="/preload.js"></script>
  <script src="/app.js"></script>
</body>
</html>`;
}

export function registerTaskmdSidecar(app: SidecarAppLike, options: TaskmdSidecarOptions): { bumpRevision(): void; dispose(): void } {
  const { files, ls } = options;
  let revision = 1;
  const bumpRevision = () => { revision += 1; };
  const unsubscribe = files.subscribe(bumpRevision);

  const wrap = (handler: (data: Record<string, unknown>) => Promise<unknown>) => async (data: Record<string, unknown>) => {
    try {
      return await handler(data);
    } catch (error) {
      return errorPayload(error);
    }
  };

  app.page('/', () => renderIndexHtml());

  app.page('/app.js', () => {
    if (!options.readAsset) {
      return 'console.error("taskmd: app.js not configured");';
    }
    const asset = options.readAsset('web/client.js');
    return typeof asset === 'string' ? asset : Buffer.from(asset).toString('utf8');
  });

  app.api('/api/revision', async () => ({ revision: String(revision) }), 'GET');
  app.api('/api/state', wrap(async () => files.state()), 'GET');

  app.api('/api/configure', wrap(async data => {
    const settings: HomeSettings = {
      homeDirectory: typeof data.homeDirectory === 'string' ? data.homeDirectory : '',
      homeWorkspaceId: typeof data.homeWorkspaceId === 'string' ? data.homeWorkspaceId : null,
      tasksDirectory: typeof data.tasksDirectory === 'string' && data.tasksDirectory.trim() ? data.tasksDirectory.trim() : 'tasks',
    };
    const next = await files.configure(settings);
    bumpRevision();
    return next;
  }));

  app.api('/api/tasks/read', wrap(async data => files.read(asString(data.id, 'id'))));

  app.api('/api/tasks/create', wrap(async data => {
    const input: CreateTaskInput = {
      title: asString(data.title, 'title'),
      ...(typeof data.body === 'string' ? { body: data.body } : {}),
      ...(typeof data.parent === 'string' && data.parent ? { parent: data.parent } : {}),
      ...(typeof data.summary === 'string' ? { summary: data.summary } : {}),
    };
    const record = await files.create(input);
    if (typeof data.sessionId === 'string' && data.sessionId.trim()) {
      await files.bind(record.task.id, data.sessionId.trim());
    }
    bumpRevision();
    return record;
  }));

  app.api('/api/tasks/update', wrap(async data => {
    const id = asString(data.id, 'id');
    const expectedVersion = asString(data.expectedVersion, 'expectedVersion');
    const changes = (data.changes && typeof data.changes === 'object' ? data.changes : {}) as TaskChanges;
    const record = await files.update(id, changes, expectedVersion);
    bumpRevision();
    return record;
  }));

  app.api('/api/tasks/delete', wrap(async data => {
    const id = asString(data.id, 'id');
    const expectedVersion = asString(data.expectedVersion, 'expectedVersion');
    const deleted = await files.remove(id, expectedVersion);
    bumpRevision();
    return { deleted };
  }));

  app.api('/api/tasks/attachment', wrap(async data => {
    const id = asString(data.id, 'id');
    const href = asString(data.href, 'href');
    return files.attachment(id, href);
  }));

  app.api('/api/bindings', wrap(async data => ({
    bindings: await files.bindings(typeof data.taskId === 'string' && data.taskId ? data.taskId : undefined),
  })));

  app.api('/api/bind', wrap(async data => {
    const taskId = asString(data.taskId, 'taskId');
    const sessionId = asString(data.sessionId, 'sessionId');
    await files.bind(taskId, sessionId);
    bumpRevision();
    return { bound: true };
  }));

  app.api('/api/unbind', wrap(async data => {
    const taskId = asString(data.taskId, 'taskId');
    const sessionId = asString(data.sessionId, 'sessionId');
    await files.unbind(taskId, sessionId);
    bumpRevision();
    return { unbound: true };
  }));

  app.api('/api/sessions/statuses', wrap(async () => {
    const statuses = await ls.listConversations({ includeArchived: true, pageSize: 100 });
    return { statuses };
  }), 'GET');

  app.api('/api/sessions/create', wrap(async data => {
    const taskId = asString(data.taskId, 'taskId');
    const projectId = typeof data.projectId === 'string' && data.projectId.trim()
      ? data.projectId.trim()
      : options.projectId;
    const { sessionId } = await ls.createConversation({
      ...(projectId ? { projectId } : {}),
      ...(typeof data.title === 'string' && data.title.trim() ? { title: data.title.trim() } : {}),
      ...(typeof data.prompt === 'string' && data.prompt.trim() ? { prompt: data.prompt.trim() } : {}),
    });
    await files.bind(taskId, sessionId);
    bumpRevision();
    return { sessionId };
  }));

  return {
    bumpRevision,
    dispose: unsubscribe,
  };
}

async function loadSidecarSdk(): Promise<{ SidecarApp: new () => SidecarAppLike }> {
  const candidates = [
    process.env.ANTIGRAVITY_APP_DATA_DIR && join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs'),
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return import(pathToFileURL(candidate).href) as Promise<{ SidecarApp: new () => SidecarAppLike }>;
    }
  }
  const moduleName = 'sidecar_sdk';
  return import(moduleName) as Promise<{ SidecarApp: new () => SidecarAppLike }>;
}

export async function startTaskmdSidecar(): Promise<void> {
  const { SidecarApp } = await loadSidecarSdk();
  const app = new SidecarApp();
  const dataDir = process.env.ANTIGRAVITY_SIDECAR_DATA_DIR
    || join(homedir(), '.gemini', 'antigravity', 'plugin_data', 'taskmd');
  const files = new TaskFiles({ localDirectory: dataDir });
  await files.init();
  const ls = createConversationServiceClient();
  const sidecarDir = dirname(fileURLToPath(import.meta.url));
  const registration = registerTaskmdSidecar(app, {
    files,
    ls,
    projectId: process.env.ANTIGRAVITY_PROJECT_ID || undefined,
    readAsset: rel => readFileSync(join(sidecarDir, rel)),
  });
  await app.run();
  const stopCdp = startCdpComposerBridge({
    files,
    onMutated: () => registration.bumpRevision(),
  });

  const shutdown = async () => {
    stopCdp();
    registration.dispose();
    files.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (isMainModule()) {
  startTaskmdSidecar().catch(error => {
    console.error('[taskmd-sidecar] failed to start:', error);
    process.exit(1);
  });
}
