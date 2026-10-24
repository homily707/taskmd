import type { ApplyResult, State, TaskRecord } from '../types.js';
import { TaskError } from '../types.js';
import type { TaskGraphPort } from '../ui/port.js';

export interface HttpPortOptions {
  /** Same-origin API prefix used by `taskmd serve`. */
  base?: string;
}

interface ErrorEnvelope {
  code?: unknown;
  message?: unknown;
  hint?: unknown;
  details?: unknown;
}

function asError(response: Response): Promise<Error> {
  return response.json().then((value: ErrorEnvelope) => {
    const code = typeof value?.code === 'string' ? value.code : 'HTTP_ERROR';
    const fallback = `HTTP ${response.status} ${response.statusText}`.trim();
    const message = typeof value?.message === 'string' ? value.message : fallback;
    const hint = typeof value?.hint === 'string' ? value.hint : '';
    return new TaskError(code, hint ? `${message} ${hint}` : message, hint, value?.details);
  }, () => new Error(`HTTP ${response.status} ${response.statusText}`.trim()));
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (!response.ok) throw await asError(response);
  return await response.json() as T;
}

/**
 * `TaskGraphPort` backed by the standalone server's HTTP API.
 *
 * Every call is same-origin by construction: the page is served by the same
 * process that answers `/api/*` and streams `/api/events`.
 */
export function createHttpPort({ base = '/api' }: HttpPortOptions = {}): TaskGraphPort {
  const listeners = new Set<() => void>();
  let events: EventSource | undefined;
  const notify = () => {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* One subscriber must not break the stream. */ }
    }
  };
  const connect = () => {
    if (events) return;
    events = new EventSource(`${base}/events`);
    events.addEventListener('ready', notify);
    events.addEventListener('change', notify);
  };
  const disconnect = () => {
    if (!events) return;
    events.close();
    events = undefined;
  };
  return {
    getState(signal) {
      return request<State>(`${base}/state`, { signal });
    },
    readTask(id, signal) {
      return request<TaskRecord>(`${base}/tasks/${encodeURIComponent(id)}`, { signal });
    },
    apply(plan, signal) {
      return request<ApplyResult>(`${base}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan),
        signal,
      });
    },
    async readAsset(id, index, signal) {
      const asset = await request<{ schemaVersion?: number; content: string; path: string; version: string }>(
        `${base}/assets/${encodeURIComponent(id)}/${index}`, { signal },
      );
      return { content: asset.content, path: asset.path, version: asset.version };
    },
    subscribe(listener) {
      listeners.add(listener);
      connect();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) disconnect();
      };
    },
  };
}
