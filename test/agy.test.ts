import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAgyAdapters, uriToWorkspacePath, type WindowSidecar } from '../src/agy/adapter.js';
import { handleBridgeRequest, isMainAntigravityPage } from '../src/agy/cdp-composer.js';
import { buildComposerInjectionScript } from '../src/agy/composer-script.js';
import { mapConversationToStatus, type ConversationServiceClient } from '../src/agy/ls.js';
import { pickPreferredSessionId } from '../src/agy/outline-pane.js';
import { registerTaskmdSidecar, type SidecarAppLike } from '../src/agy/sidecar.js';
import { TaskFiles } from '../src/core/files.js';

function createFakeSidecarApp() {
  const pages = new Map<string, () => unknown>();
  const apis = new Map<string, Map<string, (data: Record<string, unknown>) => unknown>>();
  const app: SidecarAppLike = {
    page(path, handler) {
      pages.set(path, handler);
    },
    api(path, handler, method = 'POST') {
      if (!apis.has(path)) apis.set(path, new Map());
      apis.get(path)!.set(method.toUpperCase(), handler);
    },
    async run() {},
    async close() {},
  };
  return {
    app,
    pages,
    async invokeApi<T = unknown>(path: string, data: Record<string, unknown> = {}, method = 'POST'): Promise<T> {
      const handler = apis.get(path)?.get(method.toUpperCase());
      assert.ok(handler, `Missing handler for ${method} ${path}`);
      return (await handler(data)) as T;
    },
  };
}

test('mapConversationToStatus maps Antigravity conversation states and flags', () => {
  const running = mapConversationToStatus({
    id: 'conv-1',
    annotations: { title: 'Fix auth', archived: false },
    state: { runState: 'RUN_STATE_RUNNING', updateTime: '2026-11-26T10:00:00Z' },
  });
  assert.deepEqual(running, {
    sessionId: 'conv-1',
    running: true,
    archived: false,
    child: false,
    title: 'Fix auth',
    updatedAt: Date.parse('2026-11-26T10:00:00Z'),
  });

  const childArchived = mapConversationToStatus({
    id: 'conv-2',
    metadata: { parentConversationId: 'conv-1' },
    annotations: { archived: true },
    state: { summary: 'Subagent summary', runState: 'RUN_STATE_IDLE' },
  });
  assert.deepEqual(childArchived, {
    sessionId: 'conv-2',
    running: false,
    archived: true,
    child: true,
    title: 'Subagent summary',
  });
});

test('registerTaskmdSidecar creates tasks, binds sessions, and creates bound conversations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskmd-agy-'));
  const homeDir = join(root, 'home');
  const dataDir = join(root, 'data');
  await mkdir(join(homeDir, 'tasks'), { recursive: true });
  const files = new TaskFiles({ localDirectory: dataDir });
  await files.init();

  const createdPrompts: Array<{ projectId?: string; prompt?: string }> = [];
  const ls: ConversationServiceClient = {
    async listConversations() {
      return [{ sessionId: 'conv-existing', running: false, archived: false, child: false, title: 'Existing' }];
    },
    async getConversation() {
      return undefined;
    },
    async createConversation(opts) {
      createdPrompts.push({ projectId: opts.projectId, prompt: opts.prompt });
      return { sessionId: 'conv-new-1' };
    },
  };

  const fake = createFakeSidecarApp();
  const reg = registerTaskmdSidecar(fake.app, { files, ls, projectId: 'proj-1' });
  try {
    await fake.invokeApi('/api/configure', { homeDirectory: homeDir, tasksDirectory: 'tasks' });
    const createdTask = await fake.invokeApi<{ task: { id: string } }>('/api/tasks/create', {
      title: 'Migrate taskmd',
      sessionId: 'conv-existing',
    });

    const initialBindings = await fake.invokeApi<{ bindings: Array<{ taskId: string; sessionId: string }> }>('/api/bindings', {
      taskId: createdTask.task.id,
    });
    assert.equal(initialBindings.bindings.length, 1);
    assert.equal(initialBindings.bindings[0].sessionId, 'conv-existing');

    const newSession = await fake.invokeApi<{ sessionId: string }>('/api/sessions/create', {
      taskId: createdTask.task.id,
      prompt: 'Start working',
    });
    assert.equal(newSession.sessionId, 'conv-new-1');
    assert.deepEqual(createdPrompts, [{ projectId: 'proj-1', prompt: 'Start working' }]);

    const updatedBindings = await fake.invokeApi<{ bindings: Array<{ taskId: string; sessionId: string }> }>('/api/bindings', {
      taskId: createdTask.task.id,
    });
    assert.deepEqual(
      updatedBindings.bindings.map(item => item.sessionId).sort(),
      ['conv-existing', 'conv-new-1'],
    );

    const statuses = await fake.invokeApi<{ statuses: Array<{ sessionId: string }> }>('/api/sessions/statuses', {}, 'GET');
    assert.equal(statuses.statuses[0].sessionId, 'conv-existing');
  } finally {
    reg.dispose();
    files.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('createAgyAdapters wires toggleConversation, sendMessage, and workspace URIs', async () => {
  const toggled: string[] = [];
  const sent: Array<{ sessionId?: string; message: string }> = [];
  const fakeSidecar: WindowSidecar = {
    conversationId: 'conv-current',
    async fetch() {
      return new Response(JSON.stringify({}), { status: 200 });
    },
    async getWorkspaceUris() {
      return ['file:///Users/demo/agent-home'];
    },
    agent: {
      async sendMessage(message, conversationId) {
        sent.push({ sessionId: conversationId, message });
        return {};
      },
      async startConversation() {
        return {};
      },
    },
    ui: {
      toggleConversation(conversationId) {
        toggled.push(conversationId);
      },
    },
  };

  assert.equal(uriToWorkspacePath('file:///Users/demo/agent%20home'), '/Users/demo/agent home');

  const adapters = createAgyAdapters(fakeSidecar);
  try {
    assert.equal(adapters.sessionId, 'conv-current');
    await adapters.sessions.open('conv-target');
    assert.deepEqual(toggled, ['conv-target']);

    await adapters.sessions.send?.('conv-target', 'Hello from taskmd', 'req-1');
    assert.deepEqual(sent, [{ sessionId: 'conv-target', message: 'Hello from taskmd' }]);

    const workspaces = await adapters.sessions.workspaces();
    assert.deepEqual(workspaces, [
      { workspaceId: '/Users/demo/agent-home', path: '/Users/demo/agent-home', title: 'agent-home' },
    ]);
  } finally {
    adapters.dispose();
  }
});

test('pickPreferredSessionId prefers latest non-archived session', () => {
  const bindingsByTask = new Map([
    ['t1', [{ sessionId: 's-archived' }, { sessionId: 's-old' }, { sessionId: 's-new' }]],
  ]);
  const statuses = new Map([
    ['s-archived', { archived: true, updatedAt: 999 }],
    ['s-old', { archived: false, updatedAt: 100 }],
    ['s-new', { archived: false, updatedAt: 200 }],
  ]);
  assert.equal(pickPreferredSessionId('t1', bindingsByTask, statuses), 's-new');
  assert.equal(pickPreferredSessionId('t-missing', bindingsByTask, statuses), undefined);
});

test('CDP bridge handles getState, bind, unbind and injection script parses cleanly', async () => {
  assert.doesNotThrow(() => new Function(buildComposerInjectionScript()));
  assert.equal(isMainAntigravityPage({
    id: 'p1',
    type: 'page',
    title: 'Antigravity',
    url: 'https://127.0.0.1:5387/c/abc',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p1',
  }), true);
  assert.equal(isMainAntigravityPage({
    id: 'p2',
    type: 'iframe',
    title: 'Taskmd',
    url: 'plugin://taskmd--taskmd/',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/p2',
  }), false);

  const root = await mkdtemp(join(tmpdir(), 'taskmd-cdp-'));
  const homeDir = join(root, 'home');
  const dataDir = join(root, 'data');
  await mkdir(join(homeDir, 'tasks'), { recursive: true });
  const files = new TaskFiles({ localDirectory: dataDir });
  await files.init();
  let mutations = 0;
  try {
    await files.configure({ homeDirectory: homeDir, homeWorkspaceId: null, tasksDirectory: 'tasks' });
    const created = await files.create({ title: 'CDP Task' });
    await handleBridgeRequest(files, 'bind', { taskId: created.task.id, sessionId: 'conv-cdp' }, () => { mutations += 1; });
    const state = (await handleBridgeRequest(files, 'getState', {})) as {
      tasks: Array<{ id: string; title: string }>;
      bindings: Array<{ taskId: string; sessionId: string }>;
    };
    assert.equal(state.tasks[0].title, 'CDP Task');
    assert.deepEqual(state.bindings, [{ taskId: created.task.id, sessionId: 'conv-cdp' }]);

    await handleBridgeRequest(files, 'unbind', { taskId: created.task.id, sessionId: 'conv-cdp' }, () => { mutations += 1; });
    const afterUnbind = (await handleBridgeRequest(files, 'getState', {})) as { bindings: unknown[] };
    assert.equal(afterUnbind.bindings.length, 0);
    assert.equal(mutations, 2);
  } finally {
    files.close();
    await rm(root, { recursive: true, force: true });
  }
});
