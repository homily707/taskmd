import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { TaskError, type SessionInboxModel, type SessionInboxRequest, type SessionInboxResult } from '../types.js';
import type { TaskFiles } from '../core/files.js';

/** The Host Session methods used to turn one JSON request into a normal Session. */
export interface SessionInboxController {
  create(request: { workspaceId?: string; cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>;
  modelCatalog?(): Promise<{ groups: { id: string; models: { id: string; reasoning?: { efforts: { id: string }[] } }[] }[] }>;
  selectModel?(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<unknown>;
  prompt(request: {
    requestId: string;
    sessionId: string;
    mode: 'queue';
    content: { type: 'text'; text: string }[];
    clientTimeZone?: string;
  }, signal: AbortSignal): Promise<unknown>;
}

const PROCESSING = 'processing';
const DONE = 'done';
const FAILED = 'failed';
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const hashOf = (content: string): string => createHash('sha256').update(content).digest('hex');
const emptyApplied = () => ({ created: false, model: false, bound: false, prompted: false });

function sessionIdFromError(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { code?: unknown; details?: unknown; rpcError?: { code?: unknown; details?: unknown } };
  if (candidate.code !== 'session/workspace-attach-failed' && candidate.rpcError?.code !== 'session/workspace-attach-failed') return undefined;
  const details = candidate.details ?? candidate.rpcError?.details;
  const sessionId = isObject(details) ? details.sessionId : undefined;
  return typeof sessionId === 'string' ? sessionId : undefined;
}
function errorCode(error: unknown): string {
  if (error instanceof TaskError) return error.code;
  if (isObject(error) && typeof error.code === 'string') return error.code;
  return 'session_create_failed';
}

/**
 * Watches the task inbox for JSON Session requests and turns each into exactly
 * one Session (create → optional model → optional Task bind → optional prompt).
 * Moving the request out of the inbox is the one-time claim; `processing/`,
 * `done/` and `failed/` record the outcome without a second creation.
 */
export class SessionInboxLauncher {
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private again = false;
  private closed = false;
  private recovered = false;
  private unsubscribe?: () => void;

  constructor(
    private readonly files: TaskFiles,
    private readonly controller: () => SessionInboxController | undefined,
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
  kick(): void { this.schedule(0); }

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
      console.warn('taskmd: session inbox failed', error);
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<void> {
    if (!this.recovered) {
      const directory = await this.files.inboxPath();
      if (directory) { this.recovered = true; await this.recover(); }
    }
    const controller = this.controller();
    if (!controller) return;
    const inbox = await this.files.sessionInbox();
    if (!inbox.entries.length) return;
    const directory = await this.files.inboxPath();
    if (!directory) return;
    for (const subdirectory of [PROCESSING, DONE, FAILED]) await mkdir(join(directory, subdirectory), { recursive: true, mode: 0o700 });
    for (const entry of inbox.entries) {
      const target = join(directory, PROCESSING, entry.name);
      try { await rename(entry.path, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      await this.process(directory, target, entry.name, entry.request, entry.content);
    }
  }

  /** Files left in processing belong to an interrupted run; never recreate their Session. */
  private async recover(): Promise<void> {
    const directory = await this.files.inboxPath();
    if (!directory) return;
    const processing = join(directory, PROCESSING);
    let names: string[];
    try { names = await readdir(processing); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.') || name.endsWith('.result.json')) continue;
      const now = new Date().toISOString();
      try {
        await this.finish(directory, join(processing, name), name, FAILED, {
          version: 1, source: name, status: 'unknown', applied: emptyApplied(), startedAt: now, finishedAt: now,
          error: { code: 'unknown_result', message: 'The launcher stopped before recording a result; the Session may or may not exist. Inspect the Session list before retrying.' },
        });
      } catch (error) { console.warn('taskmd: recovering an interrupted request failed', error); }
    }
  }

  private async validateModel(controller: SessionInboxController, model: SessionInboxModel): Promise<void> {
    if (!controller.modelCatalog) return;
    const catalog = await controller.modelCatalog();
    const group = catalog.groups.find(item => item.id === model.provider);
    if (!group) throw new TaskError('invalid_model', `Unknown model provider: ${model.provider}.`);
    const found = group.models.find(item => item.id === model.model);
    if (!found) throw new TaskError('invalid_model', `Unknown model: ${model.provider}/${model.model}.`);
    if (model.reasoningEffort !== undefined && !(found.reasoning?.efforts ?? []).some(item => item.id === model.reasoningEffort)) {
      throw new TaskError('invalid_model', `Unsupported reasoning effort: ${model.reasoningEffort}.`);
    }
  }

  private async process(directory: string, source: string, name: string, request: SessionInboxRequest, content: string): Promise<void> {
    const startedAt = new Date().toISOString();
    const applied = emptyApplied();
    const requestId = hashOf(content);
    let sessionId: string | undefined;
    try {
      const controller = this.controller();
      if (!controller) throw new TaskError('service_unavailable', 'The Session service is unavailable.');
      if (request.taskId) await this.files.read(request.taskId);
      if (request.model) await this.validateModel(controller, request.model);
      const created = await controller.create({
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.agentPreset ? { agentPreset: request.agentPreset } : {}),
      });
      sessionId = created.sessionId;
      applied.created = true;
      if (request.model) {
        if (!controller.selectModel) throw new TaskError('model_unavailable', 'This deployment cannot select a model.');
        await controller.selectModel({ sessionId, ...request.model });
        applied.model = true;
      }
      if (request.taskId) {
        await this.files.bind(request.taskId, sessionId);
        applied.bound = true;
      }
      if (request.prompt) {
        await controller.prompt({
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: request.prompt }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }, this.abort.signal);
        applied.prompted = true;
      }
      await this.finish(directory, source, name, DONE, {
        version: 1, source: name, status: 'done', sessionId, applied, startedAt, finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      const created = sessionId ?? sessionIdFromError(error);
      await this.finish(directory, source, name, FAILED, {
        version: 1, source: name, status: 'failed', ...(created ? { sessionId: created } : {}), applied,
        error: { code: errorCode(error), message: messageOf(error) }, startedAt, finishedAt: new Date().toISOString(),
      });
    }
  }

  private async finish(directory: string, source: string, name: string, subdirectory: string, result: SessionInboxResult): Promise<void> {
    const target = join(directory, subdirectory);
    await mkdir(target, { recursive: true, mode: 0o700 });
    try { await rename(source, join(target, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const resultPath = join(target, `${name.replace(/\.json$/, '')}.result.json`);
    const temp = join(dirname(resultPath), `.taskmd-result-${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temp, resultPath);
  }
}
