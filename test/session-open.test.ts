import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bundle = fileURLToPath(new URL('../lib/client.js', import.meta.url));

/**
 * Session navigation through the shipped bundle.
 *
 * `@deepseek-ai/dsh-client-store` is a browser-platform module whose own peer
 * dependency (`immer`) is not installed in this dev tree, so the test supplies
 * the shape DSH hands the plugin. Everything else is the real adapter code, which
 * is the only place DSH Client APIs may appear.
 */
function platformStore() {
  return {
    createSnapshotStore<T>(initial: T) {
      let value = initial;
      const listeners = new Set<() => void>();
      return {
        getSnapshot: () => value,
        set(next: T) { value = next; for (const listener of [...listeners]) listener(); },
        update(change: (draft: T) => void) {
          const draft = structuredClone(value);
          change(draft);
          value = draft;
          for (const listener of [...listeners]) listener();
        },
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      };
    },
    notifySubscribers(listeners: Iterable<() => void>) { for (const listener of [...listeners]) listener(); },
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: Error };
const ok = <T,>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });

interface Services {
  /** Extra `ctx.get` faces, keyed by service name. */
  [name: string]: unknown;
}

interface Harness {
  sessions: {
    open(sessionId: string): Promise<void>;
    send(sessionId: string, text: string, requestId: string): Promise<void>;
  };
  calls: { open: string[]; touch: string[] };
}

/**
 * Mounts the bundle, then returns the SessionCapability the main panel receives.
 *
 * `services` seeds the injection-free `ctx.get` reads that decide reachability;
 * the `touch` override lets one case fail the write the way the Host can.
 */
async function mount(options: { services?: Services; refuseTouch?: boolean } = {}): Promise<Harness> {
  const registered: Record<string, { id: string; factory(require: (name: string) => unknown): unknown }> = {};
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  scope.window = { __ModuleLoader__: { load: (spec: { id: string }) => { registered[spec.id] = spec as never; } } };
  (0, eval)(readFileSync(bundle, 'utf8'));
  scope.window = previous;

  const spec = registered.taskmd;
  assert.ok(spec, 'the bundle registers itself as "taskmd"');

  const react = await import('react');
  const modules: Record<string, unknown> = {
    react: (react as { default?: unknown }).default ?? react,
    'react/jsx-runtime': await import('react/jsx-runtime'),
    'react-dom': await import('react-dom'),
    '@deepseek-ai/dsh-client-store': platformStore(),
  };

  const calls: { open: string[]; touch: string[] } = { open: [], touch: [] };
  let root: (() => { props: Record<string, any> }) | undefined;
  const effects: (() => unknown)[] = [];
  const services: Record<string, unknown> = {
    'remote.taskmd': {
      state: () => ok({ schemaVersion: 1, revision: 'r1', tasks: [], ready: [], diagnostics: [] }),
      read: () => ok({ task: { id: 'task-1' }, content: '', version: 'v1' }),
      apply: () => ok({ schemaVersion: 1, requestId: 'r', revision: 'r2', ids: {}, versions: {} }),
      asset: () => ok({ content: '', path: '', version: 'v' }),
      bindings: () => ok([]),
      bind: () => ok(undefined),
      unbind: () => ok(undefined),
      touch: (sessionId: string) => {
        calls.touch.push(sessionId);
        // The Host folds a store refusal into a Remote error; the adapter must
        // treat it as a best-effort bookkeeping failure, not a failed jump.
        return options.refuseTouch
          ? Promise.resolve({ ok: false, error: Object.assign(new Error('touch refused'), { code: 'taskmd/store-error' }) })
          : ok(true);
      },
      repositoryDirectory: () => ok(null),
      watch: async function* watch() { /* no frames */ },
    },
    ...options.services,
  };

  const ctx = {
    effect(setup: () => () => unknown) { effects.push(setup()); return () => {}; },
    get: (name: string) => services[name],
    inject: (_names: string[], setup: (ctx: unknown) => unknown) => { setup(ctx); return { dispose() {} }; },
    remote: {
      $mount: () => Promise.resolve(() => {}),
      $stream: () => ({ async *[Symbol.asyncIterator]() { /* no frames */ }, dispose: async () => {} }),
    },
    slots: {
      inject: (_name: string, setup: () => () => unknown) => { effects.push(setup()); return () => {}; },
      register: (options2: { key?: string }, component: typeof root) => {
        if (options2.key === 'taskmd') root = component as typeof root;
        return () => {};
      },
    },
    resources: { register: () => () => {} },
    sidebarRightTabs: { register: () => () => {} },
    sessions: { create: () => Promise.resolve('created') },
    uiWorkspace: { openSession: (sessionId: string) => { calls.open.push(sessionId); } },
    layout: { selectPanel() {} },
    shortcuts: { register: () => () => {} },
  };

  const plugin = spec.factory((name: string) => {
    assert.ok(name in modules, `the bundle must not require unexpected module ${name}`);
    return modules[name];
  }) as { apply(ctx: unknown): Promise<void> };
  await plugin.apply(ctx);

  const mounted = root?.();
  assert.ok(mounted, 'the main panel component was registered');
  const sessions = mounted!.props.sessions;
  assert.ok(sessions, 'the panel receives a SessionCapability');
  return { sessions, calls };
}

/** Matches the adapter's TaskError by code, without importing across the bundle. */
function rejectsWithCode(code: string) {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code, `expected code ${code}, got ${(error as Error).message}`);
    // Every refusal must name the next step, or the UI has nothing to show.
    assert.ok(((error as { hint?: string }).hint ?? '').length > 0, 'the error carries a recovery hint');
    return true;
  };
}

test('open navigates, then records the open', { skip: !existsSync(bundle) && 'lib/client.js is not built' }, async () => {
  const { sessions, calls } = await mount();
  await sessions.open('session-1');
  assert.deepEqual(calls.open, ['session-1'], 'the layout is asked to navigate');
  assert.deepEqual(calls.touch, ['session-1'], 'the binding records the open for recency');
});

test('open refuses an archived Session and never navigates', { skip: !existsSync(bundle) && 'lib/client.js is not built' }, async () => {
  const { sessions, calls } = await mount({
    services: { workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: ['session-1'] }) } } },
  });
  await assert.rejects(sessions.open('session-1'), rejectsWithCode('session_archived'));
  // Nothing moved: no navigation, and no write to the binding.
  assert.deepEqual(calls.open, []);
  assert.deepEqual(calls.touch, []);
});

test('open refuses a forbidden Session and never navigates', { skip: !existsSync(bundle) && 'lib/client.js is not built' }, async () => {
  const { sessions, calls } = await mount({
    services: { remoteAccess: { source: () => ({ getSnapshot: () => false }) } },
  });
  await assert.rejects(sessions.open('session-1'), rejectsWithCode('session_forbidden'));
  assert.deepEqual(calls.open, []);
  assert.deepEqual(calls.touch, []);
});

test('open refuses a Session missing from a ready catalog', { skip: !existsSync(bundle) && 'lib/client.js is not built' }, async () => {
  const { sessions, calls } = await mount({
    services: { sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } } },
  });
  await assert.rejects(sessions.open('session-1'), rejectsWithCode('session_not_found'));
  assert.deepEqual(calls.open, []);
  assert.deepEqual(calls.touch, []);
});

test('a pending catalog still opens, because absence proves nothing yet', { skip: !existsSync(bundle) && 'lib/client.js is not built' }, async () => {
  const { sessions, calls } = await mount({
    services: { sessions: { list: { getSnapshot: () => ({ phase: 'pending', byId: {} }) } } },
  });
  await assert.doesNotReject(sessions.open('session-1'));
  assert.deepEqual(calls.open, ['session-1']);
});

test('a refused touch does not fail the open the user already completed', { skip: !existsSync(bundle) && 'lib/client.js is not built' }, async () => {
  const { sessions, calls } = await mount({ refuseTouch: true });
  // The jump happened, so reporting a failure now would suggest it did not.
  await assert.doesNotReject(sessions.open('session-1'));
  assert.deepEqual(calls.open, ['session-1']);
  assert.deepEqual(calls.touch, ['session-1']);
});


test('send uses the real prompt contract and forwards the stable request identity', async () => {
  const requests: unknown[] = [];
  const { sessions } = await mount({ services: { 'remote.session': {
    prompt: (request: unknown) => { requests.push(request); return ok({ accepted: true }); },
  } } });
  await sessions.send('session-1', 'start task', 'request-1');
  await sessions.send('session-1', 'start task', 'request-1');
  assert.deepEqual(requests[0], {
    sessionId: 'session-1', requestId: 'request-1', mode: 'queue',
    content: [{ type: 'text', text: 'start task' }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  assert.deepEqual(requests[0], requests[1]);
});

test('send reports a missing prompt service and remote rejections', async () => {
  const missing = await mount();
  await assert.rejects(missing.sessions.send('session-1', 'go', 'r'), (error: unknown) => (error as { code: string }).code === 'session_service_unavailable');
  const rejected = await mount({ services: { 'remote.session': {
    prompt: async () => ({ ok: false, error: Object.assign(new Error('refused'), { code: 'session/agent-busy' }) }),
  } } });
  await assert.rejects(rejected.sessions.send('session-1', 'go', 'r'), (error: unknown) => (error as { code: string }).code === 'session/agent-busy');
});
