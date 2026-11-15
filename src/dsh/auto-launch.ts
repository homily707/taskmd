import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HomeSettings, TaskRecord } from '../types.js';
import type { TaskFiles } from '../core/files.js';
import { initialPrompt } from '../core/prompt.js';

/** The Session methods used by the Host-side inbox launcher. */
export interface AutoLaunchSessionController {
  create(request: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>;
  prompt(request: {
    requestId: string;
    sessionId: string;
    mode: 'queue';
    content: { type: 'text'; text: string }[];
    clientTimeZone?: string;
  }, signal: AbortSignal): Promise<unknown>;
}

type LaunchStatus = 'pending' | 'creating' | 'created' | 'done' | 'unknown' | 'failed';

interface LaunchRecord {
  taskId: string;
  source: string;
  requestId: string;
  status: LaunchStatus;
  sessionId?: string;
  sent?: boolean;
  error?: string;
  updatedAt: string;
}

type LaunchData = Record<string, Record<string, LaunchRecord>>;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const statuses = new Set<LaunchStatus>(['pending', 'creating', 'created', 'done', 'unknown', 'failed']);

function validRecord(value: unknown, taskId: string): LaunchRecord | undefined {
  if (!isObject(value) || value.taskId !== taskId || typeof value.source !== 'string'
    || typeof value.requestId !== 'string' || typeof value.status !== 'string' || !statuses.has(value.status as LaunchStatus)
    || typeof value.updatedAt !== 'string'
    || (value.sessionId !== undefined && typeof value.sessionId !== 'string')
    || (value.sent !== undefined && typeof value.sent !== 'boolean')
    || (value.error !== undefined && typeof value.error !== 'string')) return undefined;
  return {
    taskId,
    source: value.source,
    requestId: value.requestId,
    status: value.status as LaunchStatus,
    updatedAt: value.updatedAt,
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
    ...(value.sent !== undefined ? { sent: value.sent } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
  };
}

function sessionIdFromError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; details?: unknown; rpcError?: { code?: unknown; details?: unknown } };
  if (candidate.code !== 'session/workspace-attach-failed' && candidate.rpcError?.code !== 'session/workspace-attach-failed') return undefined;
  const details = candidate.details ?? candidate.rpcError?.details;
  const sessionId = isObject(details) ? details.sessionId : undefined;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

/**
 * Watches the task inbox and turns each valid new document into one bound
 * Session. Moving the document out of the inbox is the one-time claim; the
 * launch record makes retries restartable without creating a second Session.
 */
export class InboxAutoLauncher {
  private readonly records = new Map<string, LaunchRecord>();
  private data: LaunchData = {};
  private key = '';
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private again = false;
  private closed = false;
  private unsubscribe?: () => void;

  constructor(
    private readonly files: TaskFiles,
    private readonly localDirectory: string,
    private readonly controller: () => AutoLaunchSessionController | undefined,
  ) {}

  /** The launcher owns one permanent TaskFiles subscriber, keeping polling alive without a page. */
  start(): void {
    if (this.closed) return;
    this.unsubscribe = this.files.subscribe(() => this.schedule(700));
    this.schedule(0);
  }

  close(): void {
    this.closed = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Retry after the Session service becomes available or configuration changes. */
  kick(): void {
    for (const record of this.records.values()) {
      if (record.status === 'failed') { record.status = 'pending'; record.error = undefined; }
    }
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, delay);
    this.timer.unref?.();
  }

  async pump(): Promise<void> {
    if (this.closed) return;
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.runOnce();
      } while (this.again && !this.closed);
    } catch (error) {
      console.warn('taskmd: inbox auto-launch failed', error);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<void> {
    const state = await this.files.state();
    const key = this.files.homeKey();
    if (!key) return;
    await this.load(key);
    const inbox = await this.files.inboxEntries();
    const existingIds = new Set(state.tasks.map(record => record.task.id));
    const seen = new Set<string>();
    let changed = false;
    for (const entry of inbox.entries) {
      // A file that duplicates an existing task is left for inspection; it
      // must not trigger a Session for the already-existing task.
      if (existingIds.has(entry.task.id) || seen.has(entry.task.id)) continue;
      seen.add(entry.task.id);
      changed = this.ensure(entry.task.id, entry.name) || changed;
    }
    if (changed) await this.persist();
    if (inbox.entries.length) {
      // The move is the claim: once a file leaves the inbox it is never imported twice.
      await this.files.importInbox();
    }
    const next = await this.files.state();
    for (const record of [...this.records.values()]) await this.advance(record, next.settings);
    await this.persist();
  }

  private ensure(taskId: string, source: string): boolean {
    if (this.records.has(taskId)) return false;
    this.records.set(taskId, {
      taskId, source, requestId: randomUUID(), status: 'pending', sent: false,
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  private async advance(record: LaunchRecord, settings: HomeSettings): Promise<void> {
    if (record.status === 'done' || record.status === 'unknown' || record.status === 'failed') return;
    if (record.status === 'creating') {
      // The process died after handing the create request to the Host; a blind
      // retry could leave a second Session, so stop and let the user inspect.
      record.status = 'unknown';
      record.error = 'Session creation result is unknown; inspect the Session list before retrying.';
      record.updatedAt = new Date().toISOString();
      return;
    }
    if (!(await this.files.hasTask(record.taskId))) {
      const inbox = await this.files.inboxEntries();
      if (!inbox.entries.some(entry => entry.task.id === record.taskId)) {
        record.status = 'failed';
        record.error = 'Inbox file disappeared before it could be imported.';
        record.updatedAt = new Date().toISOString();
      }
      return;
    }
    let task: TaskRecord;
    try { task = await this.files.read(record.taskId); }
    catch (error) {
      record.status = 'failed'; record.error = messageOf(error); record.updatedAt = new Date().toISOString();
      return;
    }
    if (!record.sessionId) {
      const existing = await this.files.bindings(record.taskId);
      if (existing.length) { record.status = 'done'; record.updatedAt = new Date().toISOString(); return; }
      const controller = this.controller();
      if (!controller) return;
      record.status = 'creating'; record.error = undefined; record.updatedAt = new Date().toISOString();
      await this.persist();
      try {
        const created = await controller.create({
          ...(settings.homeWorkspaceId ? { workspaceId: settings.homeWorkspaceId } : { cwd: settings.homeDirectory }),
        });
        record.sessionId = created.sessionId;
        record.status = 'created';
        record.updatedAt = new Date().toISOString();
        await this.persist();
      } catch (error) {
        const created = sessionIdFromError(error);
        if (created) {
          record.sessionId = created;
          record.status = 'created';
          record.error = messageOf(error);
          record.updatedAt = new Date().toISOString();
          await this.persist();
        } else {
          record.status = 'failed'; record.error = messageOf(error); record.updatedAt = new Date().toISOString();
          await this.persist();
          return;
        }
      }
    }
    if (!record.sessionId) return;
    const bound = (await this.files.bindings(record.taskId)).some(binding => binding.sessionId === record.sessionId);
    if (!bound) {
      try { await this.files.bind(record.taskId, record.sessionId); }
      catch (error) {
        record.status = 'failed'; record.error = messageOf(error); record.updatedAt = new Date().toISOString();
        await this.persist();
        return;
      }
    }
    if (record.sent) { record.status = 'done'; record.updatedAt = new Date().toISOString(); return; }
    const controller = this.controller();
    if (!controller) return;
    try {
      await controller.prompt({
        requestId: record.requestId,
        sessionId: record.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: initialPrompt(task) }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, this.abort.signal);
      record.sent = true;
      record.status = 'done';
      record.error = undefined;
      record.updatedAt = new Date().toISOString();
      await this.persist();
    } catch (error) {
      record.status = 'failed'; record.error = messageOf(error); record.updatedAt = new Date().toISOString();
      await this.persist();
    }
  }

  private async load(key: string): Promise<void> {
    if (this.key === key) return;
    this.key = key;
    this.records.clear();
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.localDirectory, 'auto-launch.json'), 'utf8'));
      if (!isObject(parsed)) return;
      this.data = parsed as LaunchData;
      const section = this.data[key];
      if (!isObject(section)) return;
      for (const [taskId, value] of Object.entries(section)) {
        const record = validRecord(value, taskId);
        if (record) this.records.set(taskId, record);
      }
      // A failed launch is retried once per plugin start; kick() also resets
      // failures after configuration changes.
      for (const record of this.records.values()) {
        if (record.status === 'failed') { record.status = 'pending'; record.error = undefined; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('taskmd: reading auto-launch state failed', error);
      this.data = {};
    }
  }

  private async persist(): Promise<void> {
    if (!this.key) return;
    this.data[this.key] = Object.fromEntries(this.records);
    await mkdir(this.localDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.localDirectory, 'auto-launch.json');
    const temp = join(dirname(path), `.taskmd-auto-launch-${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, path);
  }
}
