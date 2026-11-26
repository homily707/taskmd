import {
  TaskError,
  type Attachment,
  type CreateTaskInput,
  type HomeSettings,
  type State,
  type TaskChanges,
  type TaskRecord,
  type TaskSessionBinding,
} from '../types.js';
import type {
  SessionCapability,
  SessionStatus,
  SessionStatusSource,
  TaskPort,
  WorkspaceSummary,
} from '../ui/port.js';

export interface WindowSidecar {
  conversationId?: string | null;
  fetch(url: string, options?: RequestInit): Promise<Response>;
  getWorkspaceUris(): Promise<string[]>;
  onWorkspaceChange?(listener: (uris: string[]) => void): () => void;
  agent?: {
    sendMessage(message: string, conversationId?: string): Promise<unknown>;
    startConversation(message: string, title?: string): Promise<unknown>;
  };
  ui?: {
    toggleAuxPane?(request: unknown): void;
    toggleConversation?(conversationId: string, options?: Record<string, unknown>): void;
  };
}

export function getWindowSidecar(): WindowSidecar | undefined {
  return (globalThis as { window?: { sidecar?: WindowSidecar } }).window?.sidecar;
}

export function uriToWorkspacePath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri.replace(/^file:\/\//, '');
  }
}

export function workspaceTitleFromPath(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean);
  return parts.at(-1) || path;
}

async function requestJson<T>(
  fetcher: (url: string, options?: RequestInit) => Promise<Response>,
  url: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const response = await fetcher(url, {
    method: options?.method ?? 'POST',
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!response.ok) throw new Error(text);
      throw new Error(`Invalid JSON response from ${url}`);
    }
  }
  if (!response.ok) {
    const err = parsed as { error?: string; code?: string; details?: unknown };
    if (err.code) {
      throw new TaskError(err.code, err.error || response.statusText, err.details);
    }
    throw new Error(err.error || response.statusText || `HTTP ${response.status}`);
  }
  return parsed as T;
}

export interface AgyAdapters {
  port: TaskPort;
  sessions: SessionCapability;
  sessionId?: string;
  dispose(): void;
}

export function createAgyAdapters(sidecar: WindowSidecar | undefined = getWindowSidecar()): AgyAdapters {
  const fetcher: (url: string, options?: RequestInit) => Promise<Response> =
    sidecar?.fetch ? sidecar.fetch.bind(sidecar) : fetch.bind(globalThis);

  const taskListeners = new Set<() => void>();
  const statusListeners = new Set<() => void>();
  let statusMap = new Map<string, SessionStatus>();
  let lastRevision = '';

  const notifyTasks = () => {
    for (const listener of taskListeners) listener();
  };
  const notifyStatuses = () => {
    for (const listener of statusListeners) listener();
  };

  const pollRevision = async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try {
      const { revision } = await requestJson<{ revision: string }>(fetcher, '/api/revision', { method: 'GET' });
      if (lastRevision && revision !== lastRevision) {
        notifyTasks();
      }
      lastRevision = revision;
    } catch {
      // Ignore transient poll errors; active operations surface their own errors.
    }
  };

  const refreshStatuses = async () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try {
      const { statuses } = await requestJson<{ statuses: SessionStatus[] }>(fetcher, '/api/sessions/statuses', { method: 'GET' });
      const next = new Map<string, SessionStatus>();
      for (const item of statuses) next.set(item.sessionId, item);
      statusMap = next;
      notifyStatuses();
    } catch {
      // Keep last known statuses if language server is temporarily unreachable.
    }
  };

  let revisionTimer: ReturnType<typeof setInterval> | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;

  const ensureRevisionTimer = () => {
    if (revisionTimer || taskListeners.size === 0) return;
    void pollRevision();
    revisionTimer = setInterval(() => { void pollRevision(); }, 2500);
  };
  const maybeStopRevisionTimer = () => {
    if (taskListeners.size === 0 && revisionTimer) {
      clearInterval(revisionTimer);
      revisionTimer = undefined;
    }
  };

  const ensureStatusTimer = () => {
    if (statusTimer || statusListeners.size === 0) return;
    void refreshStatuses();
    statusTimer = setInterval(() => { void refreshStatuses(); }, 5000);
  };
  const maybeStopStatusTimer = () => {
    if (statusListeners.size === 0 && statusTimer) {
      clearInterval(statusTimer);
      statusTimer = undefined;
    }
  };

  const port: TaskPort = {
    getState: signal => requestJson<State>(fetcher, '/api/state', { method: 'GET', signal }),
    configure: async settings => {
      const state = await requestJson<State>(fetcher, '/api/configure', { body: settings });
      notifyTasks();
      return state;
    },
    readTask: (id, signal) => requestJson<TaskRecord>(fetcher, '/api/tasks/read', { body: { id }, signal }),
    createTask: async (input: CreateTaskInput) => {
      const record = await requestJson<TaskRecord>(fetcher, '/api/tasks/create', { body: input });
      notifyTasks();
      return record;
    },
    updateTask: async (id: string, changes: TaskChanges, expectedVersion: string) => {
      const record = await requestJson<TaskRecord>(fetcher, '/api/tasks/update', { body: { id, changes, expectedVersion } });
      notifyTasks();
      return record;
    },
    deleteTask: async (id: string, expectedVersion: string) => {
      const { deleted } = await requestJson<{ deleted: string[] }>(fetcher, '/api/tasks/delete', { body: { id, expectedVersion } });
      notifyTasks();
      return deleted;
    },
    readAttachment: (id: string, href: string) =>
      requestJson<Attachment>(fetcher, '/api/tasks/attachment', { body: { id, href } }),
    subscribe: listener => {
      taskListeners.add(listener);
      ensureRevisionTimer();
      return () => {
        taskListeners.delete(listener);
        maybeStopRevisionTimer();
      };
    },
  };

  const statusSource: SessionStatusSource = {
    get: () => statusMap,
    subscribe: listener => {
      statusListeners.add(listener);
      ensureStatusTimer();
      return () => {
        statusListeners.delete(listener);
        maybeStopStatusTimer();
      };
    },
  };

  const sessions: SessionCapability = {
    list: async (taskId, signal) => {
      const { bindings } = await requestJson<{ bindings: TaskSessionBinding[] }>(fetcher, '/api/bindings', {
        body: taskId ? { taskId } : {},
        signal,
      });
      return bindings;
    },
    statuses: () => statusSource,
    title: sessionId => statusMap.get(sessionId)?.title,
    open: async sessionId => {
      if (!sidecar?.ui?.toggleConversation) {
        throw new Error('当前环境不支持跳转到会话（缺少 window.sidecar.ui.toggleConversation）。');
      }
      sidecar.ui.toggleConversation(sessionId);
    },
    create: async (taskId, options) => {
      const result = await requestJson<{ sessionId: string }>(fetcher, '/api/sessions/create', {
        body: {
          taskId,
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        },
      });
      void refreshStatuses();
      notifyTasks();
      return result;
    },
    bind: async (taskId, sessionId) => {
      await requestJson(fetcher, '/api/bind', { body: { taskId, sessionId } });
      notifyTasks();
    },
    unbind: async (taskId, sessionId) => {
      await requestJson(fetcher, '/api/unbind', { body: { taskId, sessionId } });
      notifyTasks();
    },
    currentDirectory: async () => {
      const uris = await sidecar?.getWorkspaceUris?.().catch(() => []) ?? [];
      return uris.length ? uriToWorkspacePath(uris[0]) : null;
    },
    subscribeTargets: listener => sidecar?.onWorkspaceChange ? sidecar.onWorkspaceChange(() => listener()) : () => {},
    workspaces: async () => {
      const uris = await sidecar?.getWorkspaceUris?.().catch(() => []) ?? [];
      const seen = new Set<string>();
      const items: WorkspaceSummary[] = [];
      for (const uri of uris) {
        const path = uriToWorkspacePath(uri);
        if (!path || seen.has(path)) continue;
        seen.add(path);
        items.push({ workspaceId: path, path, title: workspaceTitleFromPath(path) });
      }
      return items;
    },
    send: async (sessionId, text) => {
      if (!sidecar?.agent?.sendMessage) {
        throw new Error('当前环境不支持发送会话消息（缺少 window.sidecar.agent.sendMessage）。');
      }
      await sidecar.agent.sendMessage(text, sessionId);
      void refreshStatuses();
    },
  };

  return {
    port,
    sessions,
    sessionId: sidecar?.conversationId?.trim() || undefined,
    dispose() {
      if (revisionTimer) clearInterval(revisionTimer);
      if (statusTimer) clearInterval(statusTimer);
      taskListeners.clear();
      statusListeners.clear();
    },
  };
}
