import { join } from 'node:path';
import { Service, type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { isRemoteJsonValue, Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-api-gateway';
import type {} from '@deepseek-ai/dsh-api-remote-access';
import type { SessionId } from '@deepseek-ai/dsh-session';
import { TaskFiles } from '../core/files.js';
import { InboxAutoLauncher, type AutoLaunchSessionController } from './auto-launch.js';
import { TaskError, type Attachment, type CreateTaskInput, type HomeSettings, type State, type TaskChanges, type TaskRecord, type TaskSessionBinding } from '../types.js';
import type { TaskmdChange, TaskmdRemote, TaskmdFileError } from './remote.js';
import { registerTaskTools } from './tools.js';

const sessionResource = (_taskId: string, sessionId: string) => sessionId as SessionId;
const touchedSession = (sessionId: string) => sessionId as SessionId;

interface SessionForkRequest { readonly sessionId: string }
interface SessionForkValue { readonly sessionId: string }
interface SessionControllerLike {
  fork(request: SessionForkRequest): Promise<SessionForkValue>;
}

/** The child a failed workspace attach already created, if any. */
function attachFailedChildId(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; details?: unknown; rpcError?: { code?: unknown; details?: unknown } };
  const code = typeof candidate.code === 'string' ? candidate.code : candidate.rpcError?.code;
  if (code !== 'session/workspace-attach-failed') return undefined;
  const details = candidate.details ?? candidate.rpcError?.details;
  if (!details || typeof details !== 'object') return undefined;
  const sessionId = (details as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

export default class TaskmdHost extends TypertRemoteService implements TaskmdRemote {
  static inject = ['typertGateway', 'remoteAccess', 'profileContext'];
  static Config = z.object({});
  private readonly files: TaskFiles;
  private readonly launcher: InboxAutoLauncher;
  private readonly initialized: PromiseLike<unknown>;
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private sessionController?: AutoLaunchSessionController;

  constructor(ctx: Context) {
    super(ctx, 'taskmd');
    // dsh-app-boot provides ProfileContext before the profile plugin tree.
    const profile = ctx.get('profileContext') as { dir: string };
    const localDirectory = join(profile.dir, 'data', 'taskmd');
    this.files = new TaskFiles({ localDirectory });
    this.launcher = new InboxAutoLauncher(this.files, localDirectory, () => this.sessionController);
    this.initialized = ctx.effect(async () => {
      try { await this.files.init(); this.launcher.start(); } catch (error) { this.files.close(); throw error; }
      return async () => {
        this.lifetime.abort();
        this.launcher.close();
        await Promise.allSettled([...this.pending]);
        this.files.close();
      };
    }, 'taskmd: files and change stream');
    registerTaskTools(ctx, this);
    this.watchForks(ctx);
    ctx.inject(['sessionController'], scope => {
      this.sessionController = scope.get('sessionController') as AutoLaunchSessionController | undefined;
      this.launcher.kick();
      return () => { this.sessionController = undefined; };
    });
  }

  /**
   * The Host-side fork guard. The Client wrapper only runs while a Web page is
   * loaded; this one keeps task ownership intact for forks from any client and
   * from the moment the Host half reloads.
   */
  private watchForks(ctx: Context): void {
    ctx.inject(['sessionController'], scope => scope.effect(() => {
      const controller = scope.get('sessionController') as SessionControllerLike | undefined;
      const original = controller?.fork;
      if (!controller || typeof original !== 'function') return () => {};
      const own = Object.prototype.hasOwnProperty.call(controller, 'fork')
        ? Object.getOwnPropertyDescriptor(controller, 'fork')
        : undefined;
      const wrapped = async (request: SessionForkRequest): Promise<SessionForkValue> => {
        // Capture the task before the fork starts, so an archive during child
        // creation cannot make the source binding disappear first.
        const taskId = await this.files.taskForSession(request.sessionId).catch(() => undefined);
        const bindChild = async (childId: string) => {
          if (!taskId) return;
          try { await this.files.bind(taskId, childId); }
          catch (error) { console.warn('taskmd: binding the forked Session failed', error); }
        };
        try {
          const child = await original.call(controller, request);
          await bindChild(child.sessionId);
          return child;
        } catch (error) {
          const childId = attachFailedChildId(error);
          if (childId) await bindChild(childId);
          throw error;
        }
      };
      try { controller.fork = wrapped; } catch { return () => {}; }
      return () => {
        if (own) Object.defineProperty(controller, 'fork', own);
        else { try { Reflect.deleteProperty(controller, 'fork'); } catch { /* another wrapper owns it */ } }
      };
    }, 'taskmd: fork binding'));
  }

  async [Service.init](): Promise<void> { await this.initialized; }
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialized;
    if (this.lifetime.signal.aborted) throw new RemoteError('taskmd/unavailable', 'The taskmd plugin is stopping.', {});
    const pending = operation();
    this.pending.add(pending);
    try { return await pending; }
    catch (error) {
      if (error instanceof TaskError) throw new RemoteError('taskmd/file-error', error.message, { code: error.code, ...(isRemoteJsonValue(error.details) ? { details: error.details } : {}) });
      throw error;
    } finally { this.pending.delete(pending); }
  }
  @Remote('state')
  state(): Promise<State> { return this.run(() => this.files.state()); }
  @Remote('configure')
  configure(settings: HomeSettings): Promise<State> {
    return this.run(() => this.files.configure(settings).finally(() => this.launcher.kick()));
  }
  @Remote('read')
  read(taskId: string): Promise<TaskRecord> { return this.run(() => this.files.read(taskId)); }
  @Remote('create')
  create(input: CreateTaskInput): Promise<TaskRecord> { return this.run(() => this.files.create(input)); }
  @Remote('update')
  update(taskId: string, changes: TaskChanges, expectedVersion: string): Promise<TaskRecord> { return this.run(() => this.files.update(taskId, changes, expectedVersion)); }
  @Remote('removeTask')
  removeTask(taskId: string, expectedVersion: string): Promise<string[]> { return this.run(() => this.files.remove(taskId, expectedVersion)); }
  @Remote('attachment')
  attachment(taskId: string, href: string): Promise<Attachment> { return this.run(() => this.files.attachment(taskId, href)); }
  @Remote('bindings')
  bindings(taskId?: string): Promise<TaskSessionBinding[]> {
    return this.run(async () => (await this.files.bindings(taskId)).filter(binding => this.ctx.remoteAccess.allows({ kind: 'session', id: binding.sessionId as SessionId })));
  }
  @Remote({ name: 'bind', resources: { session: sessionResource } })
  bind(taskId: string, sessionId: string): Promise<void> { return this.run(() => this.files.bind(taskId, sessionId)); }
  @Remote({ name: 'unbind', resources: { session: sessionResource } })
  unbind(taskId: string, sessionId: string): Promise<void> { return this.run(() => this.files.unbind(taskId, sessionId)); }
  @Remote({ name: 'touch', resources: { session: touchedSession } })
  touch(sessionId: string): Promise<boolean> { return this.run(() => this.files.touch(sessionId)); }
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<TaskmdChange> {
    await this.initialized;
    const cancelled = AbortSignal.any([signal, this.lifetime.signal]);
    if (cancelled.aborted) return;
    let dirty = true;
    let sequence = 0;
    let wake: (() => void) | undefined;
    const unsubscribe = this.files.subscribe(() => { dirty = true; wake?.(); });
    const abort = () => wake?.();
    cancelled.addEventListener('abort', abort, { once: true });
    try {
      while (!cancelled.aborted) {
        if (!dirty) { await new Promise<void>(resolve => { wake = resolve; }); wake = undefined; }
        if (cancelled.aborted) return;
        dirty = false;
        yield { revision: String(++sequence) };
      }
    } finally { cancelled.removeEventListener('abort', abort); unsubscribe(); }
  }
}

declare module '@deepseek-ai/cordis' { interface Context { taskmd: TaskmdHost } }
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'taskmd/file-error': TaskmdFileError; 'taskmd/unavailable': Record<string, never> }
}
