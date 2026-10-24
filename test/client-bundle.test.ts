import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createOptions } from '../src/ui/session-target.js';

const bundle = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/**
 * The platform's snapshot store, reduced to the surface the bundle touches.
 *
 * `@deepseek-ai/dsh-client-store` is a browser-platform module whose own peer
 * dependency (`immer`) is not installed here, so the test supplies the shape
 * DSH hands the plugin rather than importing the package.
 */
function platformStore() {
  return {
    createSnapshotStore<T>(initial: T) {
      let value = initial;
      const listeners = new Set<() => void>();
      const fire = () => { for (const listener of [...listeners]) listener(); };
      return {
        getSnapshot: () => value,
        set(next: T) { value = next; fire(); },
        update(change: (draft: T) => void) {
          const draft = structuredClone(value);
          change(draft);
          value = draft;
          fire();
        },
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      };
    },
    notifySubscribers(listeners: Iterable<() => void>) {
      for (const listener of [...listeners]) listener();
    },
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: Error };
const ok = <T>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });
const refuse = (code: string, message: string, details?: unknown): Promise<Result<never>> =>
  Promise.resolve({ ok: false, error: Object.assign(new Error(message), { code, ...(details ? { details } : {}) }) });

/**
 * A stand-in for the DSH Client root, carrying only the faces the plugin touches.
 *
 * The bundle is the shipped artifact, so this exercises the real adapter code —
 * the one place DSH APIs may appear — instead of a parallel test double.
 */
function fakeContext(calls: Record<string, unknown[]>) {
  const task = {
    schema: 1 as const, id: 'task-1', title: '任务', status: 'in_progress' as const, parent: null,
    blocked_by: [], order: 'a1', repo: 'harless', assets: [], archived: false, body: '',
  };
  const state = { schemaVersion: 1 as const, revision: 'r1', tasks: [task], ready: [], diagnostics: [] };
  const effects: (() => unknown)[] = [];
  let root: (() => { props: Record<string, any> }) | undefined;
  let bindFails = false;
  const ctx = {
    effect(setup: () => () => unknown) { effects.push(setup()); return () => {}; },
    get(name: string) {
      if (name === 'remote.taskmd') return {
        state: () => ok(state),
        read: () => ok({ task, content: '', version: 'v1' }),
        apply: (plan: { requestId: string }) => ok({ schemaVersion: 1, requestId: plan.requestId, revision: 'r2', ids: {}, versions: {} }),
        asset: () => refuse('taskmd/asset-not-found', 'no assets'),
        bindings: () => ok([]),
        bind: (taskId: string, sessionId: string) => {
          (calls.bind as unknown[]).push([taskId, sessionId]);
          // The store's refusal, folded into a Remote error the way the Host does.
          return bindFails
            ? refuse('taskmd/store-error', `Session ${sessionId} is already bound.`, {
              code: 'session_already_bound', hint: '', details: { existingTaskId: 'task-other', sessionId },
            })
            : ok(undefined);
        },
        unbind: () => ok(undefined),
        repositoryDirectory: () => ok('/repo/harless'),
        watch: async function* () { /* no frames */ },
      };
      if (name === 'workspaces') return {
        list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', path: '/repo/harless', title: 'harless' }] }), subscribe: () => () => {} },
        subscribe: () => () => {},
      };
      if (name === 'remote.session') return {
        modelCatalog: () => ok({
          default: { provider: 'p', model: 'm' }, routableProviders: ['p'], failures: [],
          groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'M', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }] }],
        }),
        selectModel: (selection: unknown) => { (calls.selectModel as unknown[]).push(selection); return ok({ selected: { provider: 'p', model: 'm' } }); },
      };
      return undefined;
    },
    remote: {
      $mount: () => Promise.resolve(() => {}),
      $stream: () => ({ async *[Symbol.asyncIterator]() { /* no frames */ }, dispose: async () => {} }),
    },
    slots: {
      inject: (_name: string, setup: () => () => unknown) => { effects.push(setup()); return () => {}; },
      // The main panel registration is where the capability reaches the UI.
      register: (options: { key?: string }, component: typeof root) => {
        if (options.key === 'taskmd') root = component as typeof root;
        return () => {};
      },
    },
    resources: { register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    sessions: {
      create: (options: unknown) => {
        (calls.create as unknown[]).push(options);
        return Promise.resolve('s-1');
      },
    },
    uiWorkspace: { openSession: (id: string) => { (calls.open as unknown[]).push(id); } },
  };
  return {
    ctx, effects,
    root: () => root,
    failBind(value: boolean) { bindFails = value; },
  };
}

/** Loads the shipped Client bundle the way DSH's module loader does. */
async function loadBundle() {
  const registered: Record<string, { id: string; factory(require: (name: string) => unknown): any }> = {};
  const scope = globalThis as { window?: unknown };
  scope.window = { __ModuleLoader__: { load: (spec: { id: string }) => { registered[spec.id] = spec as never; } } };
  const react = await import('react');
  const modules: Record<string, unknown> = {
    react: (react as { default?: unknown }).default ?? react,
    'react/jsx-runtime': await import('react/jsx-runtime'),
    'react-dom': await import('react-dom'),
    'react-dom/client': await import('react-dom/client'),
    // The platform supplies this exact instance; only its import-time shape is needed.
    '@deepseek-ai/dsh-client-store': platformStore(),
  };
  (0, eval)(readFileSync(bundle, 'utf8'));
  const spec = registered.taskmd;
  assert.ok(spec, 'the bundle registers itself as "taskmd"');
  return spec.factory((name: string) => {
    assert.ok(name in modules, `the bundle must not require unexpected module ${name}`);
    return modules[name];
  }) as { inject: string[]; apply(ctx: unknown): Promise<void> };
}

test('the built client bundle mounts and exposes the T3 session capability', {
  skip: !existsSync(bundle) && 'lib/client.js is not built',
}, async () => {
  const calls = { create: [], selectModel: [], bind: [], open: [] };
  const fake = fakeContext(calls);
  const plugin = await loadBundle();
  // Model selection needs the Session Remote namespace; Workspace listing does not.
  assert.ok(plugin.inject.includes('remote.session'), 'the model catalog requires the session Remote');
  assert.ok(plugin.inject.includes('sessions'), 'creating a Session requires the sessions service');

  await plugin.apply(fake.ctx);
  const root = fake.root();
  assert.ok(root, 'the main panel component was registered');
  const sessions = root!().props.sessions;
  assert.ok(sessions, 'the panel receives a SessionCapability');

  // Workspace data: the Client service list, projected down to id/path/title.
  assert.deepEqual(await sessions.workspaces(), [{ workspaceId: 'w1', path: '/repo/harless', title: 'harless' }]);
  // The Task's registered repository directory, resolved Host-side.
  assert.equal(await sessions.directory('task-1'), '/repo/harless');
  const catalog = await sessions.catalog();
  assert.equal(catalog.groups[0].models[0].reasoning.defaultEffort, 'low');

  await sessions.selectModel('s-1', { provider: 'p', model: 'm', reasoningEffort: 'low' });
  assert.deepEqual(calls.selectModel, [{ sessionId: 's-1', provider: 'p', model: 'm', reasoningEffort: 'low' }]);

  // A Workspace target sends workspaceId alone, and the Session is bound at once.
  assert.deepEqual(await sessions.create('task-1', { workspaceId: 'w1' }), { sessionId: 's-1' });
  assert.deepEqual(calls.create.at(-1), { workspaceId: 'w1' });
  assert.deepEqual(calls.bind.at(-1), ['task-1', 's-1']);

  // The Host rejects a request carrying both, so a Workspace must win.
  await sessions.create('task-1', { workspaceId: 'w1', directory: '/elsewhere' });
  assert.deepEqual(calls.create.at(-1), { workspaceId: 'w1' });
  await sessions.create('task-1', { directory: '/repo/harless' });
  assert.deepEqual(calls.create.at(-1), { cwd: '/repo/harless' });
  await sessions.create('task-1', createOptions({ kind: 'directory', cwd: '/manual/override', label: 'manual' }));
  assert.deepEqual(calls.create.at(-1), { cwd: '/manual/override' });

  // A failed bind must not discard the created Session.
  fake.failBind(true);
  await assert.rejects(sessions.create('task-1', { workspaceId: 'w1' }), (error: {
    code: string; details?: { sessionId?: string; existingTaskId?: string };
  }) => {
    assert.equal(error.code, 'session_already_bound');
    assert.equal(error.details?.sessionId, 's-1');
    assert.equal(error.details?.existingTaskId, 'task-other');
    return true;
  });
  fake.failBind(false);

  for (const dispose of fake.effects) { try { await dispose(); } catch { /* teardown is best effort */ } }
});
