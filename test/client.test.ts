import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

/** What the bundle shows the loader: the registered client-module spec. */
interface ModuleSpec { id: string; factory(require: (name: string) => unknown): ClientExports }
/** The plugin's public Client entry points. */
interface ClientExports {
  apply(ctx: unknown): Promise<void>;
  inject: string[];
}
/** One `slots.register` call, as recorded by the fake context. */
interface SlotRegistration { name: string; key?: string; id?: string; order?: number; label?: string }
/** One `shortcuts.register` call, mirrored from the service's own contract. */
interface ShortcutCommand {
  id: string;
  label(): string;
  aliases?: string[];
  defaults: Record<string, { code: string; modifiers: string[] }>;
  regions: string[];
  modals: string[];
  resolve(context: { target: Element | null }): { status: 'handled'; run(): void } | { status: 'pass' | 'blocked'; reason?: string };
}

const bundle = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const require = createRequire(import.meta.url);

/** A minimal DOM stand-in: the bundle is loaded, not rendered. */
function fakeDocument() {
  const element = () => ({
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    setAttribute() {}, removeAttribute() {}, appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {},
  });
  return {
    documentElement: element(),
    body: element(),
    head: element(),
    createElement: element,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null,
    visibilityState: 'visible',
  };
}

/**
 * Loads `lib/client.js` the way the DSH module loader does: the bundle registers
 * a CommonJS factory, and the loader supplies the platform instances of React
 * and the Client store. Returns the plugin exports plus the loader's view.
 */
function loadClient() {
  const registered: ModuleSpec[] = [];
  // `window` must BE the global object: the bundle starts with
  // `window.__ModuleLoader__.load(...)`, exactly like the DSH web shell.
  const sandbox = {
    document: fakeDocument(),
    navigator: { platform: 'MacIntel', languages: ['zh-CN'], language: 'zh-CN', clipboard: undefined },
    innerWidth: 1280,
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask, console,
    URL, AbortSignal, AbortController, DOMException, structuredClone,
    __ModuleLoader__: { load: (spec: ModuleSpec) => registered.push(spec) },
  };
  const context = vm.createContext(sandbox);
  // `window`/`self`/`globalThis` are the same object the bundle sees.
  Object.assign(sandbox, { window: context, self: context, globalThis: context });
  vm.runInContext(readFileSync(bundle, 'utf8'), context, { filename: bundle });

  assert.equal(registered.length, 1, 'the bundle registers exactly one module');
  const spec = registered[0];
  assert.equal(spec.id, 'taskmd');

  const store = {
    getSnapshot: () => 0,
    subscribe: () => () => {},
    set() {},
    update() {},
  };
  const stubbed: Record<string, unknown> = {
    react: require('react'),
    'react-dom': require('react-dom'),
    'react/jsx-runtime': require('react/jsx-runtime'),
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore: () => ({ ...store, subscribe: () => () => {} }),
      notifySubscribers: () => {},
      defineStore: () => ({ create: () => ({ getSnapshot: () => ({}), subscribe: () => () => {}, actions: {} }) }),
    },
  };
  const exports = spec.factory((name) => {
    if (name === 'util') return { types: {} };
    const value = stubbed[name];
    if (!value) throw new Error(`unexpected require: ${name}`);
    return value;
  });
  return exports;
}

/**
 * The mounted `remote.taskmd` namespace, shaped like the Host's Remote methods:
 * every call resolves a `RemoteResult`, so the adapter's `unwrap` path is real.
 */
function fakeRemote(overrides: Record<string, unknown> = {}) {
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  const bindings = [
    { taskId: 'task-1', provider: 'dsh', instanceId: 'machine', sessionId: 'session-bound', createdAt: '2026-01-01T00:00:00.000Z' },
  ];
  const calls: { bind: [string, string][]; unbind: [string, string][]; touch: string[]; open: string[] } = { bind: [], unbind: [], touch: [], open: [] };
  const remote = {
    state: async () => ok({ schemaVersion: 1, revision: 'r1', tasks: [], diagnostics: [], ready: [] }),
    read: async () => ({ ok: false, error: Object.assign(new Error('task_not_found'), { code: 'task_not_found' }) }),
    apply: async () => ok({ schemaVersion: 1, requestId: 'x', revision: 'r2', ids: {}, versions: {} }),
    asset: async () => ok({ content: '', path: '', version: 'v' }),
    bindings: async () => ok(bindings),
    bind: async (taskId: string, sessionId: string) => { calls.bind.push([taskId, sessionId]); return ok(undefined); },
    unbind: async (taskId: string, sessionId: string) => { calls.unbind.push([taskId, sessionId]); return ok(undefined); },
    touch: async (sessionId: string) => { calls.touch.push(sessionId); return ok(true); },
    repositoryDirectory: async () => ok(null),
    watch: async function* watch() { /* never yields: the plugin must tolerate an idle stream */ },
    ...overrides,
  };
  return { remote, calls };
}

/** Records every effect the plugin installs so the test can run them. */
function fakeContext(overrides: {
  services?: Record<string, unknown>;
  ctx?: Record<string, unknown>;
} = {}) {
  const effects: { setup: () => unknown; label?: string }[] = [];
  const injections: { names: string[]; setup: (ctx: unknown) => unknown }[] = [];
  const registered: {
    shortcuts: ShortcutCommand[];
    resources: unknown[];
    sidebarRightTabs: unknown[];
    slots: SlotRegistration[];
  } = { shortcuts: [], resources: [], sidebarRightTabs: [], slots: [] };
  const disposers: (() => void)[] = [];
  const { remote, calls } = fakeRemote();
  const services: Record<string, unknown> = {
    'remote.taskmd': remote,
    ...(overrides.services ?? {}),
  };
  const ctx = {
    effect(setup: () => unknown, label?: string) {
      effects.push({ setup, label });
      const dispose = typeof setup === 'function' ? setup() : undefined;
      if (typeof dispose === 'function') disposers.push(() => { void (dispose as () => unknown)(); });
      return dispose ?? (() => {});
    },
    get: (name: string) => (services as Record<string, unknown>)[name],
    inject(names: string[], setup: (ctx: unknown) => unknown) {
      injections.push({ names, setup });
      return { dispose() {} };
    },
    slots: {
      inject: (name: string, setup: () => unknown) => { const dispose = setup(); return typeof dispose === 'function' ? dispose : () => {}; },
      register: (options: SlotRegistration) => { registered.slots.push(options); return () => {}; },
    },
    remote: {
      $mount: async () => () => {},
      $stream: () => ({ dispose: async () => {}, [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    },
    resources: { register: (provider: unknown) => { registered.resources.push(provider); return () => {}; } },
    sidebarRightTabs: { register: (definition: unknown) => { registered.sidebarRightTabs.push(definition); return () => {}; } },
    sessions: { create: async () => 'session-created' },
    uiWorkspace: { openSession: (sessionId: string) => { calls.open.push(sessionId); } },
    layout: { selectPanel() {} },
    shortcuts: { register: (command: ShortcutCommand) => { registered.shortcuts.push(command); return () => {}; } },
    ...overrides.ctx,
  };
  return { ctx, effects, injections, registered, disposers, calls, services };
}

test('the client bundle boots against a fake context', { skip: !existsSync(bundle) && 'lib/client.js is not built' }, () => {
  const exports = loadClient();
  assert.equal(typeof exports.apply, 'function');
  assert.ok(Array.isArray(exports.inject));
  assert.ok(exports.inject.includes('slots'));
  assert.ok(exports.inject.includes('remote'));
  // `shortcuts` and `layout` are injected through a child fiber, never statically,
  // so a Client without them still boots.
  assert.equal(exports.inject.includes('shortcuts'), false);
  assert.equal(exports.inject.includes('layout'), false);
  assert.equal(typeof exports.apply, 'function');
});

test('the plugin registers taskmd.open without default bindings', { skip: !existsSync(bundle) && 'lib/client.js is not built' }, async () => {
  const exports = loadClient();
  const { ctx, injections } = fakeContext();
  await exports.apply(ctx);
  assert.ok(ctx !== undefined);

  const shortcutInjection = injections.find((item) => item.names.includes('shortcuts'));
  assert.ok(shortcutInjection, 'a child fiber injects the shortcuts service');
  assert.ok(shortcutInjection.names.includes('layout'), 'the same fiber injects layout');

  // Run the child fiber against the same fake context.
  const child = fakeContext();
  shortcutInjection.setup(child.ctx);
  assert.equal(child.registered.shortcuts.length, 1);

  const command = child.registered.shortcuts[0];
  assert.equal(command.id, 'taskmd.open');
  assert.equal(typeof command.label(), 'string');
  assert.ok(command.label().length > 0);
  // Values cross the bundle's realm boundary, so compare contents, not identity.
  assert.deepEqual([...command.regions], ['page', 'editable', 'terminal']);
  assert.deepEqual([...command.modals], []);

  assert.deepEqual(Object.keys(command.defaults), []);
});

test('taskmd.open selects the panel only when the host runs the resolved action', { skip: !existsSync(bundle) && 'lib/client.js is not built' }, async () => {
  const exports = loadClient();
  const { ctx, injections, registered } = fakeContext();
  await exports.apply(ctx);
  const shortcutInjection = injections.find((item) => item.names.includes('shortcuts'));
  assert.ok(shortcutInjection);

  const selected: (string | null)[] = [];
  const child = fakeContext({ ctx: { layout: { selectPanel: (id: string | null) => selected.push(id) } } });
  shortcutInjection.setup(child.ctx);
  const command = child.registered.shortcuts[0];

  const resolution = command.resolve({ target: null });
  assert.equal(resolution.status, 'handled');
  command.resolve({ target: null });
  assert.deepEqual(selected, [], 'resolution must not navigate, including repeated key events');
  if (resolution.status !== 'handled') assert.fail('expected an executable command');
  resolution.run();
  // The panel id must match the keyed `main` slot this plugin registers.
  assert.deepEqual(selected, ['taskmd']);
  // The panel slot is registered on the plugin's own context, not the child fiber.
  const mainSlot = registered.slots.find((slot) => slot.name === 'main');
  assert.equal(mainSlot?.key, 'taskmd');
});
