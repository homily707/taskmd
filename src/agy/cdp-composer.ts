import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TaskFiles } from '../core/files.js';
import { buildComposerInjectionScript } from './composer-script.js';

interface CdpTarget {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (msg: { method?: string; params?: Record<string, unknown> }) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export function resolveDevToolsPortFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ANTIGRAVITY_CDP_PORT_FILE) return env.ANTIGRAVITY_CDP_PORT_FILE;
  const userDataDir = env.ANTIGRAVITY_USER_DATA_DIR || (
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Antigravity')
      : process.platform === 'win32'
        ? join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity')
        : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity')
  );
  return join(userDataDir, 'DevToolsActivePort');
}

export function readDevToolsPort(portFile = resolveDevToolsPortFile()): number | undefined {
  try {
    if (!existsSync(portFile)) return undefined;
    const firstLine = readFileSync(portFile, 'utf8').split(/\r?\n/)[0]?.trim();
    const port = Number(firstLine);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

export function isMainAntigravityPage(target: CdpTarget): boolean {
  if (target.type !== 'page' || !target.webSocketDebuggerUrl || !target.url) return false;
  try {
    const url = new URL(target.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return false;
    const title = target.title || '';
    return title.includes('Antigravity') || /^\/(?:c\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

function connectCdp(wsUrl: string): Promise<CdpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const eventListeners = new Set<(msg: { method?: string; params?: Record<string, unknown> }) => void>();
    const closeListeners = new Set<() => void>();

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP connect timeout'));
    }, 4000);

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP connect error'));
    });

    ws.addEventListener('close', () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP closed'));
      }
      pending.clear();
      for (const listener of closeListeners) listener();
    });

    ws.addEventListener('message', event => {
      let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof msg.id === 'number') {
        const entry = pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
        else entry.resolve(msg.result);
      } else {
        for (const listener of eventListeners) listener(msg);
      }
    });

    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP not open'));
          return new Promise((res, rej) => {
            const id = ++seq;
            const callTimer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} timeout`));
            }, 6000);
            pending.set(id, { resolve: res, reject: rej, timer: callTimer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        onEvent: listener => eventListeners.add(listener),
        onClose: listener => closeListeners.add(listener),
        close: () => ws.close(),
      });
    });
  });
}

export async function handleBridgeRequest(
  files: TaskFiles,
  action: string,
  payload: Record<string, unknown>,
  onMutated?: () => void,
): Promise<unknown> {
  if (action === 'getState') {
    const [state, bindings] = await Promise.all([files.state(), files.bindings()]);
    return {
      tasks: state.tasks
        .filter(item => !item.task.archived)
        .map(item => ({ id: item.task.id, title: item.task.title, status: item.task.status })),
      bindings: bindings.map(item => ({ taskId: item.taskId, sessionId: item.sessionId })),
    };
  }
  if (action === 'bind') {
    const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!taskId || !sessionId) throw new Error('taskId and sessionId are required');
    await files.bind(taskId, sessionId);
    onMutated?.();
    return { bound: true };
  }
  if (action === 'unbind') {
    const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
    if (!taskId || !sessionId) throw new Error('taskId and sessionId are required');
    await files.unbind(taskId, sessionId);
    onMutated?.();
    return { unbound: true };
  }
  throw new Error(`Unknown bridge action: ${action}`);
}

export function startCdpComposerBridge(options: {
  files: TaskFiles;
  onMutated?: () => void;
  portFile?: string;
}): () => void {
  const { files, onMutated, portFile } = options;
  const connected = new Map<string, CdpClient>();
  let stopped = false;
  let scanning = false;
  const script = buildComposerInjectionScript();

  const attachTarget = async (target: CdpTarget) => {
    if (!target.webSocketDebuggerUrl || connected.has(target.id)) return;
    let client: CdpClient;
    try {
      client = await connectCdp(target.webSocketDebuggerUrl);
    } catch {
      return;
    }
    if (stopped) {
      client.close();
      return;
    }
    connected.set(target.id, client);
    client.onClose(() => connected.delete(target.id));

    client.onEvent(msg => {
      if (msg.method !== 'Runtime.bindingCalled' || msg.params?.name !== '__taskmdBridge') return;
      const raw = typeof msg.params.payload === 'string' ? msg.params.payload : '';
      let parsed: { id?: number; action?: string; payload?: Record<string, unknown> };
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof parsed.id !== 'number' || typeof parsed.action !== 'string') return;
      void handleBridgeRequest(files, parsed.action, parsed.payload ?? {}, onMutated)
        .then(result => client.send('Runtime.evaluate', {
          expression: `window.__taskmdResolve?.(${parsed.id}, true, ${JSON.stringify(result)})`,
        }))
        .catch(error => client.send('Runtime.evaluate', {
          expression: `window.__taskmdResolve?.(${parsed.id}, false, ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })})`,
        }))
        .catch(() => {});
    });

    try {
      await client.send('Runtime.enable');
      await client.send('Runtime.addBinding', { name: '__taskmdBridge' });
      await client.send('Runtime.evaluate', { expression: script });
    } catch {
      client.close();
      connected.delete(target.id);
    }
  };

  const scan = async () => {
    if (stopped || scanning) return;
    scanning = true;
    try {
      const port = readDevToolsPort(portFile);
      if (!port) return;
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (!res.ok) return;
      const targets = (await res.json()) as CdpTarget[];
      for (const target of targets) {
        if (isMainAntigravityPage(target) && !connected.has(target.id)) {
          await attachTarget(target);
        }
      }
      for (const client of connected.values()) {
        void client.send('Runtime.evaluate', { expression: script }).catch(() => {});
      }
    } catch {
      // Silently ignore when debug port is absent or restarting.
    } finally {
      scanning = false;
    }
  };

  const unsubscribe = files.subscribe(() => {
    for (const client of connected.values()) {
      void client.send('Runtime.evaluate', { expression: 'window.__taskmdNotify?.()' }).catch(() => {});
    }
  });

  void scan();
  const timer = setInterval(() => { void scan(); }, 3000);

  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    for (const client of connected.values()) client.close();
    connected.clear();
  };
}
