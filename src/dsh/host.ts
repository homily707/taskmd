import { Service, type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { isRemoteJsonValue, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-gateway';
import type {} from '@deepseek-ai/dsh-api-remote-access';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { Store } from '../core/store.js';
import {
  TaskError, type ApplyResult, type Plan, type State, type TaskRecord,
  type TaskSessionBinding, type TaskSessionBindingFilter,
} from '../types.js';
import type { TaskmdAsset, TaskmdChange, TaskmdRemote, TaskmdStoreError } from './remote.js';

export interface Config {
  store?: string;
}

const sessionResource = (_taskId: string, sessionId: string) => sessionId as SessionId;
/** `touch` takes only the Session, so its reader has a one-argument arity. */
const touchedSession = (sessionId: string) => sessionId as SessionId;
const bindingResource = (filter?: TaskSessionBindingFilter) => filter?.sessionId as SessionId | undefined;

const filterKeys = new Set(['taskId', 'provider', 'instanceId', 'sessionId']);

function optionalString(value: Record<string, unknown>, key: string, code: string, hint: string): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== 'string' || !field.trim()) throw new TaskError(code, `Expected an optional ${key} string.`, hint);
  return field;
}

/** Rejects unknown keys so a stale client cannot smuggle state through a Remote. */
function bindingFilter(filter: unknown): TaskSessionBindingFilter {
  if (filter === undefined || filter === null) return {};
  if (typeof filter !== 'object' || Array.isArray(filter)
    || Object.keys(filter).some(key => !filterKeys.has(key))) {
    throw new TaskError('invalid_filter', 'Expected optional taskId, provider, instanceId, and sessionId strings.', 'Use a task or DSH session ID to filter bindings.');
  }
  const record = filter as Record<string, unknown>;
  return {
    ...(optionalString(record, 'taskId', 'invalid_filter', 'Use a task ID to filter bindings.') === undefined ? {} : { taskId: record.taskId as string }),
    ...(optionalString(record, 'provider', 'invalid_filter', 'Use a provider such as dsh.') === undefined ? {} : { provider: record.provider as string }),
    ...(optionalString(record, 'instanceId', 'invalid_filter', 'Omit the instance ID to read this machine.') === undefined ? {} : { instanceId: record.instanceId as string }),
    ...(optionalString(record, 'sessionId', 'invalid_filter', 'Use a DSH session ID to filter bindings.') === undefined ? {} : { sessionId: record.sessionId as string }),
  };
}

/** The shared store is global; binding rows additionally require their Session resource. */
export default class TaskmdHost extends TypertRemoteService implements TaskmdRemote {
  static inject = ['typertGateway', 'remoteAccess'];
  static Config = z.object({ store: z.string() });

  private readonly store: Store;
  private readonly initialized: PromiseLike<unknown>;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(ctx: Context, config: Config) {
    super(ctx, 'taskmd');
    this.store = new Store({ root: config.store });
    this.initialized = ctx.effect(async () => {
      try {
        await this.store.init();
      } catch (error) {
        this.store.close();
        throw error;
      }
      return async () => {
        this.lifetime.abort();
        this.store.close();
        await Promise.allSettled([...this.pending]);
      };
    }, 'taskmd: store and Remote streams');
  }

  async [Service.init](): Promise<void> {
    await this.initialized;
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialized;
    if (this.lifetime.signal.aborted) throw new RemoteError('taskmd/unavailable', 'The taskmd plugin is stopping.', {});
    const pending = operation();
    this.pending.add(pending);
    try {
      return await pending;
    } catch (error) {
      if (error instanceof TaskError) {
        throw new RemoteError('taskmd/store-error', error.message, {
          code: error.code,
          hint: error.hint,
          ...(isRemoteJsonValue(error.details) ? { details: error.details } : {}),
        });
      }
      throw error;
    } finally {
      this.pending.delete(pending);
    }
  }

  // The Gateway's supported source descriptors read these parameter names.
  // Keep them intact when bundling; cancellation is the final `signal` slot.
  @Remote('state')
  state(): Promise<State> {
    return this.run(() => this.store.state());
  }

  @Remote('read')
  read(taskId: string): Promise<TaskRecord> {
    return this.run(() => this.store.read(taskId));
  }

  @Remote('apply')
  apply(plan: Plan): Promise<ApplyResult> {
    return this.run(() => this.store.apply(plan));
  }

  @Remote('asset')
  asset(taskId: string, index: number): Promise<TaskmdAsset> {
    return this.run(() => this.store.readAsset(taskId, index));
  }

  @Remote({ name: 'bindings', resources: { session: bindingResource } })
  bindings(filter?: TaskSessionBindingFilter): Promise<TaskSessionBinding[]> {
    return this.run(async () => {
      const bindings = await this.store.listSessionBindings(bindingFilter(filter));
      // Collection admission covers the request; each returned identity still
      // needs its own Session access, just like sessionController.list().
      return bindings.filter(binding => this.ctx.remoteAccess.allows({ kind: 'session', id: binding.sessionId as SessionId }));
    });
  }

  @Remote({ name: 'bind', resources: { session: sessionResource } })
  bind(taskId: string, sessionId: string): Promise<void> {
    return this.run(() => this.store.bindSession(taskId, sessionId));
  }

  @Remote({ name: 'unbind', resources: { session: sessionResource } })
  unbind(taskId: string, sessionId: string): Promise<void> {
    return this.run(() => this.store.unbindSession(taskId, sessionId));
  }

  @Remote({ name: 'touch', resources: { session: touchedSession } })
  touch(sessionId: string): Promise<boolean> {
    return this.run(() => this.store.touchSessionBinding(sessionId));
  }

  @Remote('repositoryDirectory')
  repositoryDirectory(taskId: string): Promise<string | null> {
    return this.run(() => this.store.repositoryDirectory(taskId));
  }

  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<TaskmdChange> {
    await this.initialized;
    const cancelled = AbortSignal.any([signal, this.lifetime.signal]);
    if (cancelled.aborted) return;
    let dirty = true;
    let wake: (() => void) | undefined;
    const unsubscribe = this.store.subscribe(() => {
      dirty = true;
      wake?.();
    });
    const abort = () => {
      unsubscribe();
      wake?.();
    };
    cancelled.addEventListener('abort', abort, { once: true });
    try {
      while (!cancelled.aborted) {
        if (!dirty) {
          await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
          if (cancelled.aborted) return;
        }
        dirty = false;
        const state = await this.state();
        if (cancelled.aborted) return;
        // Do not suppress equal revisions: local CLI bindings and repository
        // mappings change independently of the shared Markdown revision.
        yield { revision: state.revision };
      }
    } finally {
      cancelled.removeEventListener('abort', abort);
      unsubscribe();
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskmd: TaskmdHost;
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'taskmd/store-error': TaskmdStoreError;
    'taskmd/unavailable': Record<string, never>;
  }
}
