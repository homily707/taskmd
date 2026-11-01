import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import type {
  ModelCatalog, ModelSelection, SessionCapability, SessionStatus, SessionStatusSource, TaskGraphPort, WorkspaceSummary,
} from '../ui/port.js';
import { TaskError, type State, type TaskRecord } from '../types.js';
import { assertSessionReachable } from './session-nav.js';
import type { TYPERT_REMOTE } from '../dsh/remote.js';

export type Dispose = () => void;
type Result<T> = { ok: true; value: T } | { ok: false; error: Error };
type Value<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>;

/**
 * Reads one stable failure code from anything the Host or a Client service
 * throws. Client plugin bundles do not share class identity, so the shape —
 * `code`, or a nested `rpcError.code` — decides.
 */
export function failureCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; rpcError?: { code?: unknown } };
  if (typeof candidate.code === 'string') return candidate.code;
  if (candidate.rpcError && typeof candidate.rpcError.code === 'string') return candidate.rpcError.code;
  return undefined;
}

/** The Session a failed attach created, per `session/workspace-attach-failed`. */
export function attachFailedSessionId(error: unknown): string | undefined {
  if (failureCode(error) !== 'session/workspace-attach-failed') return undefined;
  const details = (error as { details?: unknown }).details
    ?? (error as { rpcError?: { details?: unknown } }).rpcError?.details;
  if (!details || typeof details !== 'object') return undefined;
  const sessionId = (details as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

/** Turns one Session-creation failure into a message a user can act on. */
export function creationMessage(error: unknown, workspacePath?: string): string {
  const code = failureCode(error);
  const message = asError(error).message;
  if (code === 'workspace/not-found') {
    return `所选 Workspace 已不存在${workspacePath ? `（${workspacePath}）` : ''}，请刷新后重新选择。`;
  }
  if (code === 'agent-preset/not-found' || code === 'agent-preset/invalid') {
    return `Agent preset 不可用，请留空使用默认 preset 后重试。${message}`;
  }
  if (code === 'session/workspace-attach-failed') {
    return `会话已创建，但 Host 挂载工作目录失败：${message}`;
  }
  if (code === 'gateway/bad-request') {
    return `创建参数被 Host 拒绝（workspaceId 与 cwd 不能同时传）：${message}`;
  }
  return message;
}

// Narrow structural faces of the shipped DSH 0.2.1-rc.2 Client APIs.
// No Host services enter the browser bundle.
export interface TaskmdRemote {
  state(): Promise<Result<State>>;
  read(taskId: string): Promise<Result<TaskRecord>>;
  apply(plan: Parameters<TaskGraphPort['apply']>[0]): Promise<Result<Value<TaskGraphPort['apply']>>>;
  asset(taskId: string, index: number): Promise<Result<Value<TaskGraphPort['readAsset']>>>;
  bindings(filter?: { taskId?: string; sessionId?: string }): Promise<Result<Value<SessionCapability['list']>>>;
  bind(taskId: string, sessionId: string): Promise<Result<unknown>>;
  unbind(taskId: string, sessionId: string): Promise<Result<unknown>>;
  /** Records an open of one bound Session; `false` when no binding matched. */
  touch(sessionId: string): Promise<Result<boolean>>;
  repositoryDirectory(taskId: string): Promise<Result<string | null>>;
  watch(signal: AbortSignal): AsyncIterable<Result<{ revision: string }>>;
}

/** The subset of the DSH Client context the data adapters need. */
export interface DshAdapterScope {
  /** Injection-free service read; `remote.taskmd` only exists after $mount. */
  get(name: string): unknown;
  remote: {
    $mount(contribution: typeof TYPERT_REMOTE): Promise<Dispose>;
    $stream<T>(options: {
      name: string;
      open(signal: AbortSignal): AsyncIterable<Result<T>>;
      ended(): Error;
    }): AsyncIterable<{ value: T; accept(): void }> & { dispose(): Promise<void> };
  };
  /** Creates a blank Session from exactly one of `workspaceId` or `cwd`. */
  sessions: { create(options: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<string> };
  uiWorkspace: { openSession(sessionId: string): void };
}

/** The `remote.session` namespace: the model catalog and per-Session selection. */
interface SessionRemote {
  modelCatalog(): Promise<Result<ModelCatalog>>;
  selectModel(selection: { sessionId: string } & ModelSelection): Promise<Result<{ selected: ModelSelection }>>;
  prompt(request: { sessionId: string; requestId: string; mode: 'queue'; content: { type: 'text'; text: string }[]; clientTimeZone?: string }): Promise<Result<{ accepted: true }>>;
}

/** The `workspaces` Client service's snapshot list, as this adapter reads it. */
interface WorkspaceService {
  list: {
    getSnapshot(): { items: WorkspaceSummary[]; archivedSessionIds: readonly string[] };
    subscribe(listener: () => void): () => void;
  };
}

/** One row of the session controller's `sessions.list` snapshot. */
interface SessionListEntry {
  running?: boolean;
  blank?: boolean;
  updatedAt?: number;
  displayTitle?: string;
  projectionValues?: {
    agentPreset?: string;
    tokenUsage?: Partial<Record<'uncachedInputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens', number>>;
  };
}

/** The session controller's catalog service, extended with live projections. */
interface SessionCatalogService {
  list: {
    getSnapshot(): {
      phase: string;
      byId: Record<string, SessionListEntry>;
      projectionsBySession?: Record<string, { values?: { subagentCatalog?: { id: string; mode?: string }[] } }>;
    };
    subscribe(listener: () => void): () => void;
  };
}

/** The `uiSession` service: running, pending interaction and fresh completion. */
interface UiSessionService {
  sessionStatus: {
    getSnapshot(): Map<string, {
      running?: boolean;
      pendingInteraction?: { kind?: string };
      completionUnread?: boolean;
    }>;
    subscribe(listener: () => void): () => void;
  };
}

/** Only these pending kinds are user-visible, mirroring the workspace sidebar. */
function visiblePending(kind: string | undefined): SessionStatus['pending'] {
  return kind === 'approval' || kind === 'plan-review' || kind === 'question' ? kind : undefined;
}

function countRunningSubagents(
  snapshot: ReturnType<SessionCatalogService['list']['getSnapshot']>,
  status: ReturnType<UiSessionService['sessionStatus']['getSnapshot']>,
  sessionId: string,
): number | undefined {
  const children = snapshot.projectionsBySession?.[sessionId]?.values?.subagentCatalog;
  if (!children?.length) return undefined;
  let count = 0;
  for (const child of children) {
    if (child.mode === 'external') continue;
    if ((status.get(child.id)?.running ?? snapshot.byId[child.id]?.running) === true) count += 1;
  }
  return count;
}

/** Merges the Client's session stores into one display-only status snapshot. */
function collectSessionStatuses(scope: DshAdapterScope): Map<string, SessionStatus> {
  const catalog = (scope.get('sessions') as SessionCatalogService | undefined)?.list.getSnapshot();
  const status = (scope.get('uiSession') as UiSessionService | undefined)?.sessionStatus.getSnapshot();
  const archived = new Set((scope.get('workspaces') as WorkspaceService | undefined)
    ?.list.getSnapshot().archivedSessionIds ?? []);
  const result = new Map<string, SessionStatus>();
  const ids = new Set<string>([...Object.keys(catalog?.byId ?? {}), ...(status?.keys() ?? [])]);
  for (const id of ids) {
    const entry = catalog?.byId[id];
    const live = status?.get(id);
    const pending = visiblePending(live?.pendingInteraction?.kind);
    const usage = entry?.projectionValues?.tokenUsage;
    const tokens = usage
      ? (usage.uncachedInputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      : undefined;
    const subagents = catalog ? countRunningSubagents(catalog, status ?? new Map(), id) : undefined;
    result.set(id, {
      sessionId: id,
      running: live?.running ?? entry?.running ?? false,
      ...(pending ? { pending } : {}),
      ...(live?.completionUnread ? { fresh: true } : {}),
      ...(entry?.blank ? { blank: true } : {}),
      ...(archived.has(id) ? { archived: true } : {}),
      // Only a ready catalog may claim absence; an unready one "cannot tell".
      ...(catalog?.phase === 'ready' && !entry && !archived.has(id) ? { missing: true } : {}),
      ...(entry?.displayTitle ? { title: entry.displayTitle } : {}),
      ...(entry?.projectionValues?.agentPreset ? { agentPreset: entry.projectionValues.agentPreset } : {}),
      ...(tokens !== undefined ? { tokens } : {}),
      ...(subagents !== undefined ? { runningSubagents: subagents } : {}),
      ...(typeof entry?.updatedAt === 'number' && entry.updatedAt > 0 ? { updatedAt: entry.updatedAt } : {}),
    });
  }
  return result;
}

/**
 * One shared status source: `get` recomputes from whatever services exist, and
 * `subscribe` fans their store notifications out. Every service is optional —
 * a Client without `uiSession` still reports running/idle from the catalog.
 */
export function createSessionStatusSource(scope: DshAdapterScope): SessionStatusSource {
  const listeners = new Set<() => void>();
  const wired = new Set<string>();
  const emit = () => { for (const listener of [...listeners]) listener(); };
  const wire = (name: string, store: { subscribe(listener: () => void): (() => void) | void } | undefined) => {
    if (!store || wired.has(name)) return;
    wired.add(name);
    // A store's own dispose is dropped: this source lives for the plugin's
    // Client lifetime, shorter than every service it reads.
    store.subscribe(emit);
  };
  const ensure = () => {
    wire('sessions', (scope.get('sessions') as SessionCatalogService | undefined)?.list);
    wire('uiSession', (scope.get('uiSession') as UiSessionService | undefined)?.sessionStatus);
    wire('workspaces', (scope.get('workspaces') as WorkspaceService | undefined)?.list);
  };
  return {
    get() { ensure(); return collectSessionStatuses(scope); },
    subscribe(listener) {
      ensure();
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export async function unwrap<T>(pending: Promise<Result<T>>): Promise<T> {
  const result = await pending;
  if (!result.ok) {
    const error = result.error;
    if ('code' in error && error.code === 'taskmd/store-error' && 'details' in error) {
      const details = error.details;
      if (details && typeof details === 'object' && 'code' in details && typeof details.code === 'string') {
        const hint = 'hint' in details && typeof details.hint === 'string' ? details.hint : '';
        throw new TaskError(details.code, hint ? `${error.message} ${hint}` : error.message, hint, 'details' in details ? details.details : undefined);
      }
    }
    throw error;
  }
  return result.value;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// One caller can stop observing a shared read without canceling another tab's read.
export function observe<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const cleanup = () => signal.removeEventListener('abort', abort);
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Builds the DSH-backed {@link TaskGraphPort} and {@link SessionCapability}.
 *
 * The Remote namespace must already be mounted, since `remote.taskmd` is read
 * through `ctx.get` (it cannot appear in the static inject list). Returns the
 * shared change bus so callers can invalidate it from their own streams.
 */
export function createDshAdapters(scope: DshAdapterScope, lifetime: AbortController) {
  // One store and one supervised Host stream serve the root, session tabs and resources.
  const store = createSnapshotStore(0);
  let stateRead: Promise<State> | undefined;
  const taskReads = new Map<string, Promise<TaskRecord>>();
  const invalidate = () => {
    if (lifetime.signal.aborted) return;
    stateRead = undefined;
    taskReads.clear();
    store.set(store.getSnapshot() + 1);
  };
  const remote = scope.get('remote.taskmd') as TaskmdRemote | undefined;
  if (!remote) throw new Error('taskmd: the Remote namespace did not mount');
  const statusSource = createSessionStatusSource(scope);
  const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  const port: TaskGraphPort = {
    getState(signal) {
      lifetime.signal.throwIfAborted();
      if (!stateRead) {
        const pending = unwrap(remote.state());
        stateRead = pending;
        const settled = () => { if (stateRead === pending) stateRead = undefined; };
        void pending.then(settled, settled);
      }
      return observe(stateRead, signalFor(signal));
    },
    readTask(id, signal) {
      lifetime.signal.throwIfAborted();
      let pending = taskReads.get(id);
      if (!pending) {
        pending = unwrap(remote.read(id));
        taskReads.set(id, pending);
        const current = pending;
        const settled = () => { if (taskReads.get(id) === current) taskReads.delete(id); };
        void pending.then(settled, settled);
      }
      return observe(pending, signalFor(signal));
    },
    async apply(plan, signal) {
      signalFor(signal).throwIfAborted();
      // An admitted mutation may commit even if its caller later stops observing.
      const pending = unwrap(remote.apply(plan)).finally(invalidate);
      return observe(pending, signalFor(signal));
    },
    readAsset(id, index, signal) {
      signalFor(signal).throwIfAborted();
      return observe(unwrap(remote.asset(id, index)), signalFor(signal));
    },
    subscribe: (listener) => store.subscribe(listener),
  };
  const sessions: SessionCapability = {
    list(taskId, signal) {
      signalFor(signal).throwIfAborted();
      return observe(unwrap(remote.bindings(taskId === undefined ? {} : { taskId })), signalFor(signal));
    },
    statuses: () => statusSource,
    async open(sessionId) {
      lifetime.signal.throwIfAborted();
      // Refuse the three unreachable cases before the layout navigates, so the
      // UI reports why instead of showing an empty conversation.
      assertSessionReachable(scope, sessionId);
      scope.uiWorkspace.openSession(sessionId);
      // Record the open for recency ordering. A failed touch must not fail the
      // navigation the user already completed, so it is reported and dropped.
      try {
        await unwrap(remote.touch(sessionId));
      } catch (error) {
        if (!lifetime.signal.aborted) console.warn('taskmd: recording the session open failed', error);
        return;
      }
      invalidate();
    },
    async directory(taskId, signal) {
      // The Host resolves the Task's repo name through the local registry.
      signalFor(signal).throwIfAborted();
      const directory = await observe(unwrap(remote.repositoryDirectory(taskId)), signalFor(signal));
      return directory;
    },
    async workspaces(signal) {
      signalFor(signal).throwIfAborted();
      const service = scope.get('workspaces') as WorkspaceService | undefined;
      if (!service) return [];
      const snapshot = service.list.getSnapshot();
      return snapshot.items.map(item => ({ workspaceId: item.workspaceId, path: item.path, title: item.title }));
    },
    async catalog(signal) {
      signalFor(signal).throwIfAborted();
      const session = scope.get('remote.session') as SessionRemote | undefined;
      if (!session) throw new Error('The model catalog is unavailable in this Client.');
      return observe(unwrap(session.modelCatalog()), signalFor(signal));
    },
    async selectModel(sessionId, selection) {
      lifetime.signal.throwIfAborted();
      const session = scope.get('remote.session') as SessionRemote | undefined;
      if (!session) throw new Error('Model selection is unavailable in this Client.');
      await unwrap(session.selectModel({ sessionId, ...selection }));
    },
    async send(sessionId, text, requestId) {
      lifetime.signal.throwIfAborted();
      const session = scope.get('remote.session') as SessionRemote | undefined;
      if (!session?.prompt) throw new TaskError('session_service_unavailable', '当前 DSH 未提供消息发送接口。');
      await unwrap(session.prompt({
        sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }));
    },
    async create(taskId, options) {
      lifetime.signal.throwIfAborted();
      // `workspaceId` and `cwd` are mutually exclusive on the Host: passing both
      // is a gateway/bad-request. A Workspace wins when the caller resolved one.
      const workspaceId = options.workspaceId?.trim();
      const directory = workspaceId ? undefined
        : options.directory?.trim() || await unwrap(remote.repositoryDirectory(taskId)) || undefined;
      if (!workspaceId && !directory) throw new Error('Choose a Workspace or a directory for this task before creating a session.');
      lifetime.signal.throwIfAborted();
      let sessionId: string;
      try {
        sessionId = await scope.sessions.create({
          ...(workspaceId ? { workspaceId } : { cwd: directory }),
          ...(options.agentPreset ? { agentPreset: options.agentPreset } : {}),
        });
      } catch (error) {
        // The Host may have created the Session before attaching the directory
        // failed; its id rides on the error so the caller can rebind rather than
        // orphan a real Session.
        const created = attachFailedSessionId(error);
        if (created) {
          throw new TaskError(
            'session_attach_failed',
            `会话 ${created} 已创建，但工作目录没有挂上：${creationMessage(error)}`,
            '可以重试绑定这个会话，或直接打开它。',
            { sessionId: created },
          );
        }
        // Keep the Host code so the UI can offer a targeted recovery, such as
        // retrying without a rejected preset.
        throw new TaskError(failureCode(error) ?? 'session_create_failed', creationMessage(error, directory));
      }
      // Retain the identity in the error if creation succeeded but binding failed.
      try {
        lifetime.signal.throwIfAborted();
        await unwrap(remote.bind(taskId, sessionId));
      } catch (error) {
        invalidate();
        // The Session is real and must not be orphaned, so its id travels with
        // the failure and the UI offers a retry instead of discarding it. The
        // store's own code and details survive so `session_already_bound` can
        // still name the Task that owns it.
        const code = failureCode(error) ?? 'session_bind_failed';
        const details = (error as { details?: unknown }).details;
        const existingTaskId = details && typeof details === 'object'
          ? (details as { existingTaskId?: unknown }).existingTaskId
          : undefined;
        throw new TaskError(
          code,
          `会话 ${sessionId} 已创建，但绑定到任务失败：${asError(error).message}`,
          code === 'session_already_bound'
            ? '这个会话已经绑定到另一个任务；确认后可以解除原关联并改绑到这里。'
            : '可以重试绑定，不需要重新创建会话。',
          {
            sessionId,
            ...(typeof existingTaskId === 'string' ? { existingTaskId } : {}),
          },
        );
      }
      invalidate();
      return { sessionId };
    },
    async bind(taskId, sessionId) {
      lifetime.signal.throwIfAborted();
      await unwrap(remote.bind(taskId, sessionId));
      invalidate();
    },
    async unbind(taskId, sessionId) {
      lifetime.signal.throwIfAborted();
      await unwrap(remote.unbind(taskId, sessionId));
      invalidate();
    },
  };
  /** Drops memoized reads; used when the owning Client lifetime ends. */
  const clear = () => { stateRead = undefined; taskReads.clear(); };
  return { port, sessions, store, invalidate, clear, remote, signalFor };
}

/** Consumes the Host change stream and invalidates the shared snapshot bus. */
export async function watchChanges(
  scope: DshAdapterScope,
  remote: TaskmdRemote,
  lifetime: AbortController,
  invalidate: () => void,
): Promise<void> {
  const stream = scope.remote.$stream({
    name: 'taskmd changes',
    open: (signal) => remote.watch(signal),
    ended: () => new Error('Taskmd change stream ended'),
  });
  const stopped = () => { void stream.dispose(); };
  lifetime.signal.addEventListener('abort', stopped, { once: true });
  try {
    for await (const frame of stream) {
      if (lifetime.signal.aborted) break;
      frame.accept();
      invalidate();
    }
  } catch (error) {
    if (!lifetime.signal.aborted) {
      invalidate();
      console.error('Taskmd change stream failed', error);
    }
  } finally {
    lifetime.signal.removeEventListener('abort', stopped);
    await stream.dispose();
  }
}
