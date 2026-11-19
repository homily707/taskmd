import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshAdapters, unwrap, type DshAdapterScope, type TaskmdRemote } from '../src/adapters/dsh.js';
import { TaskError } from '../src/types.js';
import { TaskFiles } from '../src/core/files.js';
import { taskTool } from '../src/dsh/tools.js';

function harness(bindFailure = false) {
  const created: unknown[] = [];
  const prompts: unknown[] = [];
  const bindings: unknown[] = [];
  const workspaces = [{ workspaceId: 'home', path: '/home/user/home', title: 'Home' }, { workspaceId: 'repo', path: '/code/repo', title: 'Project' }];
  const remote = {
    bind: async (...args: unknown[]) => { bindings.push(args); return bindFailure ? { ok: false, error: new Error('binding failed') } : { ok: true, value: undefined }; },
    bindings: async () => ({ ok: true, value: [] }),
  } as unknown as TaskmdRemote;
  const scope: DshAdapterScope = {
    get: name => name === 'remote.taskmd' ? remote : name === 'workspaces' ? { list: { getSnapshot: () => ({ items: workspaces, archivedSessionIds: [] }), subscribe: () => () => {} } } : name === 'remote.session' ? { prompt: async (args: unknown) => { prompts.push(args); return { ok: true, value: { accepted: true } }; } } : undefined,
    sessions: { create: async options => { created.push(options); return 'created-session'; } },
    uiWorkspace: { openSession() {} },
    remote: {} as DshAdapterScope['remote'],
  };
  return { ...createDshAdapters(scope, new AbortController()), created, prompts, bindings };
}

test('status source marks forks and subagents as child sessions', async () => {
  const remote = {
    bind: async () => ({ ok: true, value: undefined }),
    bindings: async () => ({ ok: true, value: [] }),
  } as unknown as TaskmdRemote;
  const scope: DshAdapterScope = {
    get: name => {
      if (name === 'remote.taskmd') return remote;
      if (name === 'sessions') return {
        list: {
          getSnapshot: () => ({
            phase: 'ready',
            byId: {
              root: { displayTitle: 'Root' },
              fork: { displayTitle: 'Fork', parentId: 'root' },
              sub: { displayTitle: 'Sub', origin: 'subagent' },
            },
          }),
          subscribe: () => () => {},
        },
      };
      return undefined;
    },
    sessions: { create: async () => 'created' },
    uiWorkspace: { openSession() {} },
    remote: {} as DshAdapterScope['remote'],
  };
  const adapters = createDshAdapters(scope, new AbortController());
  try {
    const statuses = adapters.sessions.statuses!().get();
    assert.equal(statuses.get('root')?.child, undefined);
    assert.equal(statuses.get('fork')?.child, true);
    assert.equal(statuses.get('sub')?.child, true);
  } finally {
    adapters.clear();
  }
});

test('DSH lists all workspaces and creates at the selected repo without a cwd fallback', async () => {
  const h = harness();
  assert.equal((await h.sessions.workspaces()).length, 2);
  await h.sessions.create('task', { workspaceId: 'repo', directory: '/ignored' });
  assert.deepEqual(h.created, [{ workspaceId: 'repo' }]);
  assert.deepEqual(h.bindings, [['task', 'created-session']]);
  await assert.rejects(h.sessions.create('task', {}), /Choose/);
  assert.equal(h.created.length, 1);
});

test('binding failure preserves the created Session identity for retry', async () => {
  const h = harness(true);
  await assert.rejects(h.sessions.create('task', { workspaceId: 'home' }), error => {
    assert.ok(error instanceof TaskError);
    assert.equal(error.code, 'session_bind_failed');
    assert.deepEqual(error.details, { sessionId: 'created-session' });
    return true;
  });
  assert.equal(h.created.length, 1);
});

test('send forwards the same requestId and exact message on retry', async () => {
  const h = harness();
  await h.sessions.send!('s', 'saved snapshot', 'request-1');
  await h.sessions.send!('s', 'saved snapshot', 'request-1');
  assert.deepEqual(h.prompts[0], h.prompts[1]);
});

test('file conflicts retain business error code and latest version', async () => {
  await assert.rejects(unwrap(Promise.resolve({ ok: false, error: Object.assign(new Error('conflict'), { code: 'taskmd/file-error', details: { code: 'version_conflict', details: { latestVersion: 'new' } } }) })), error => {
    assert.ok(error instanceof TaskError);
    assert.equal(error.code, 'version_conflict');
    assert.deepEqual(error.details, { latestVersion: 'new' });
    return true;
  });
});

test('Agent tool exposes create/delete/bindings while read/update/list stay file-based', async () => {
  const root = await mkdtemp(join(tmpdir(), 'taskmd-tool-'));
  const home = join(root, 'home');
  await mkdir(home);
  const files = new TaskFiles({ localDirectory: join(root, 'local') });
  try {
    await files.init();
    await files.configure({ homeDirectory: home, homeWorkspaceId: 'home', tasksDirectory: 'tasks' });
    const api = {
      state: () => files.state(), read: (id: string) => files.read(id), create: (input: Parameters<TaskFiles['create']>[0]) => files.create(input),
      configure: (settings: Parameters<TaskFiles['configure']>[0]) => files.configure(settings),
      update: (...args: Parameters<TaskFiles['update']>) => files.update(...args), removeTask: (...args: Parameters<TaskFiles['remove']>) => files.remove(...args),
      attachment: (...args: Parameters<TaskFiles['attachment']>) => files.attachment(...args), bindings: (id?: string) => files.bindings(id),
      bind: (...args: Parameters<TaskFiles['bind']>) => files.bind(...args), unbind: (...args: Parameters<TaskFiles['unbind']>) => files.unbind(...args), touch: (id: string) => files.touch(id),
    };
    const tool = taskTool(api);
    const execute = (args: Record<string, unknown>) => tool.execute(args as never, { signal: new AbortController().signal } as never);
    const record = await execute({ action: 'create', title: 'Agent-created', body: 'Context' }) as any;
    assert.equal((await files.read(record.task.id)).task.body, 'Context');
    // read/update/list are removed from the Agent tool surface; the Agent edits files directly.
    const actions = ((tool.parameters as any).properties.action as { enum: string[] }).enum;
    assert.deepEqual([...actions].sort(), ['attachment', 'bind', 'bindings', 'configure', 'create', 'delete', 'unbind']);
    await assert.rejects(execute({ action: 'read', taskId: record.task.id }), /invalid arguments/i);
    await assert.rejects(execute({ action: 'update', taskId: record.task.id, changes: { body: 'x' } }), /invalid arguments/i);
    await assert.rejects(execute({ action: 'list' }), /invalid arguments/i);
    // Delete works without expectedVersion by using the current content hash.
    const deleted = await execute({ action: 'delete', taskId: record.task.id }) as any;
    assert.deepEqual(deleted.deleted, [record.task.id]);
    assert.equal((await files.state()).tasks.length, 0);
  } finally {
    files.close();
    assert.ok(root.startsWith(join(tmpdir(), 'taskmd-tool-')));
    await rm(root, { recursive: true, force: true });
  }
});
