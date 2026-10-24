import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { TaskmdApp, TaskmdDetailPanel, TaskmdSidebar } from '../ui/taskmd-app.js';
import type { TaskRecord } from '../types.js';
import { asError, createDshAdapters, watchChanges } from '../adapters/dsh.js';
import { TYPERT_REMOTE } from './remote.js';

type Dispose = () => void;
type Result<T> = { ok: true; value: T } | { ok: false; error: Error };

interface TabProps {
  sessionId: string;
  useTabInfo(): {
    tab: {
      contentId: string;
      signal: AbortSignal;
      actions: { openResource(address: string, options?: { kind?: string }): void };
    };
  };
}

/** One physical chord as `@deepseek-ai/dsh-client-shortcuts` stores it. */
interface ShortcutBinding {
  code: string;
  modifiers: string[];
}

/** What a command owner reports when the live target is resolved. */
type ShortcutResolution =
  | { status: 'handled'; run(): void }
  | { status: 'pass' }
  | { status: 'blocked'; reason: string };

interface ShortcutCommand {
  id: string;
  label(): string;
  aliases?: string[];
  /** Keyed by `${runtime}:${platform}`; an omitted profile stays unbound. */
  defaults: Record<string, ShortcutBinding>;
  regions: string[];
  modals: string[];
  resolve(context: { target: Element | null }): ShortcutResolution;
}

interface ClientContext {
  effect(setup: () => Dispose | (() => Promise<void>), label?: string): Dispose;
  /** Injection-free service read; `remote.taskmd` only exists after $mount. */
  get(name: string): unknown;
  /** Mounts a child fiber once the named services exist. */
  inject?(names: string[], setup: (ctx: ClientContext) => Dispose): { dispose(): void };
  slots: {
    inject(name: string, setup: () => Dispose): Dispose;
    register<P>(options: { name: string; key?: string; id?: string; order?: number; label?: string }, component: ComponentType<P>): Dispose;
  };
  remote: {
    $mount(contribution: typeof TYPERT_REMOTE): Promise<Dispose>;
    $stream<T>(options: {
      name: string;
      open(signal: AbortSignal): AsyncIterable<Result<T>>;
      ended(): Error;
    }): AsyncIterable<{ value: T; accept(): void }> & { dispose(): Promise<void> };
  };
  resources: {
    register(provider: { protocol: string; open(address: string, options: { signal: AbortSignal }): AsyncIterable<Result<TaskRecord>> }): Dispose;
  };
  sidebarRightTabs: {
    register(definition: {
      id: string;
      kind: string;
      title(address: string): string;
      patterns?: string[];
      canOpen?(address: string): boolean;
      guide?: { id: string; order: number; title(): string; description(): string; icon: ComponentType }[];
    }): Dispose;
  };
  sessions: { create(options: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<string> };
  uiWorkspace: { openSession(sessionId: string): void };
  /** Global main-panel selection; `null` selects the Conversation. */
  layout: { selectPanel(panelId: string | null): void };
  shortcuts: { register(command: ShortcutCommand): Dispose };
}

const PANEL = 'taskmd';
const SESSION_TAB = 'taskmd/session';
const DETAIL_TAB = 'taskmd/task';
const DETAIL_KIND = 'taskmdTask';
const addressOf = (id: string) => `dsh-resource://taskmd/${encodeURIComponent(id)}`;

function taskIdOf(address: string): string | undefined {
  try {
    const url = new URL(address);
    if (url.protocol !== 'dsh-resource:' || url.hostname !== 'taskmd' || url.search || url.hash) return;
    const id = decodeURIComponent(url.pathname.slice(1));
    return id && !id.includes('/') ? id : undefined;
  } catch {
    return;
  }
}

function TasksIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <path d="m3 6 2 2 3-4M11 6h10M3 13h4M11 13h10M3 20h4M11 20h10" />
  </svg>;
}

// `remote.session` carries the model catalog and per-Session selection. The
// Workspace list is read injection-free from `workspaces` (owned by a package
// this plugin does not depend on directly), so a Client without it degrades to
// a plain `cwd` instead of parking the whole plugin.
export const inject = ['slots', 'remote', 'remote.session', 'resources', 'sidebarRightTabs', 'sessions', 'uiWorkspace'];

export async function apply(ctx: ClientContext): Promise<void> {
  try {
    await setup(ctx);
  } catch (error) {
    // Boot reports only "<id>: failed" and discards the cause, so retain it for
    // post-mortem inspection from the page console.
    (globalThis as { __taskmdBootError?: unknown }).__taskmdBootError = error;
    throw error;
  }
}

async function setup(ctx: ClientContext): Promise<void> {
  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort(), 'taskmd: Client lifetime');
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE);
  if (lifetime.signal.aborted) { unmount(); return; }
  ctx.effect(() => unmount, 'taskmd: Remote namespace');

  // One store and one supervised Host stream serve the root, session tabs and resources.
  const { port, sessions, store, invalidate, clear, remote, signalFor } = createDshAdapters(ctx, lifetime);

  ctx.effect(() => {
    const running = watchChanges(ctx, remote, lifetime, invalidate);
    return async () => {
      lifetime.abort();
      await running;
      clear();
    };
  }, 'taskmd: shared change stream');

  ctx.effect(() => ctx.resources.register({
    protocol: 'taskmd',
    async *open(address, { signal }) {
      const id = taskIdOf(address);
      if (!id) { yield { ok: false, error: new Error('Invalid taskmd resource address') }; return; }
      const stopped = signalFor(signal);
      let wake: (() => void) | undefined;
      const changed = () => wake?.();
      const unsubscribe = store.subscribe(changed);
      stopped.addEventListener('abort', changed, { once: true });
      try {
        while (!stopped.aborted) {
          const generation = store.getSnapshot();
          try {
            const value = await port.readTask(id, stopped);
            if (stopped.aborted) return;
            if (generation !== store.getSnapshot()) continue;
            yield { ok: true, value };
          } catch (error) {
            if (stopped.aborted) return;
            if (generation !== store.getSnapshot()) continue;
            yield { ok: false, error: asError(error) };
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (stopped.aborted || generation !== store.getSnapshot()) resolve();
          });
          wake = undefined;
        }
      } finally {
        unsubscribe();
        stopped.removeEventListener('abort', changed);
      }
    },
  }), 'taskmd: task resources');

  function Root() {
    return <TaskmdApp port={port} sessions={sessions} />;
  }
  function SessionTasks({ sessionId, useTabInfo }: TabProps) {
    const { tab } = useTabInfo();
    const open = useCallback((id: string) => tab.actions.openResource(addressOf(id), { kind: DETAIL_KIND }), [tab.actions]);
    return <TaskmdSidebar port={port} sessions={sessions} sessionId={sessionId} onOpenTask={open} />;
  }
  function TaskDetail({ sessionId, useTabInfo }: TabProps) {
    const { tab } = useTabInfo();
    const id = taskIdOf(tab.contentId);
    const open = useCallback((taskId: string) => tab.actions.openResource(addressOf(taskId), { kind: DETAIL_KIND }), [tab.actions]);
    // The right sidebar stays compact: only the detail panel, never the full app.
    return id ? <TaskmdDetailPanel key={id} port={port} sessions={sessions} sessionId={sessionId} taskId={id} onOpenTask={open} /> : <p role="alert">Invalid task address.</p>;
  }
  function TaskTitle({ useTabInfo }: TabProps) {
    const { tab } = useTabInfo();
    const id = taskIdOf(tab.contentId);
    const [title, setTitle] = useState(id ?? 'Task');
    useEffect(() => {
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, tab.signal]);
      let request = 0;
      const refresh = () => {
        const current = ++request;
        if (!id) return;
        void port.readTask(id, signal).then((record) => {
          if (!signal.aborted && current === request) setTitle(record.task.title);
        }, () => {
          if (!signal.aborted && current === request) setTitle(id);
        });
      };
      const unsubscribe = port.subscribe(refresh);
      refresh();
      return () => { controller.abort(); unsubscribe(); };
    }, [id, tab.signal]);
    return <span>{title}</span>;
  }

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: SESSION_TAB,
    kind: 'taskmdSession',
    title: () => 'This session tasks',
    guide: [{ id: 'tasks', order: 30, title: () => 'This session tasks', description: () => 'Tasks linked to this session', icon: TasksIcon }],
  }), 'taskmd: session tab type');
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: DETAIL_TAB,
    kind: DETAIL_KIND,
    title: (address) => taskIdOf(address) ?? 'Task',
    patterns: ['dsh-resource://taskmd/*'],
    canOpen: (address) => taskIdOf(address) !== undefined,
  }), 'taskmd: detail tab type');

  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, Root)), 'taskmd: main panel');
  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 20, label: 'Tasks' }, TasksIcon)), 'taskmd: sidebar entry');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SESSION_TAB }, SessionTasks)), 'taskmd: session tab body');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: SESSION_TAB }, () => <span>This session tasks</span>)), 'taskmd: session tab title');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: DETAIL_TAB }, TaskDetail)), 'taskmd: detail tab body');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: DETAIL_TAB }, TaskTitle)), 'taskmd: detail tab title');

  // A nested inject keeps the command optional: a Client that mounts no
  // shortcuts service (or no layout) loses only the chord, never the panel. The
  // child fiber is owned by this one, so it unloads with the plugin.
  // `inject` is optional on the type because the panel must still mount when a
  // host composes a root without the shortcuts/layout layers.
  ctx.inject?.(['shortcuts', 'layout'], (inner) => inner.effect(
    () => inner.shortcuts.register({
      id: 'taskmd.open',
      label: () => '打开任务面板',
      aliases: ['taskmd', 'tasks', 'tasks panel'],
      // Users bind this command in DSH shortcut settings.
      defaults: {},
      // The panel is global, so the chord works from the editor and terminal
      // too; both keep their own bindings for every other command.
      regions: ['page', 'editable', 'terminal'],
      modals: [],
      resolve: () => ({
        status: 'handled',
        run: () => inner.layout.selectPanel(PANEL),
      }),
    }),
    'taskmd: open shortcut',
  ));
}
