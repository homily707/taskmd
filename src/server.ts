import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import type { Socket } from 'node:net';
import { Store } from './core/store.js';
import { TaskError, type Plan } from './types.js';

export const INPUT_LIMIT = 1024 * 1024;
export const PLAN_INPUT_LIMIT = 16 * 1024 * 1024;

/** Route of the bundled browser UI. Must stay in sync with {@link APP_HTML}. */
export const APP_SCRIPT_PATH = '/assets/app.js';

/**
 * Minimal document shell. It only names the bundle; every visual rule lives in
 * the React app so the standalone page and the DSH panel share one source.
 * Served under `script-src 'self'`, so the script must be an external file.
 */
export const APP_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>taskmd</title>
<style>html,body,#root{height:100%}body{margin:0}#root{display:flex;flex-direction:column}#root>*{flex:1 1 auto}</style>
</head>
<body>
<div id="root"></div>
<script src="${APP_SCRIPT_PATH}"></script>
</body>
</html>`;

/**
 * Resolves the built browser bundle. The path differs between running the
 * TypeScript sources (`src/server.ts` -> `../lib`) and the packaged CLI bundle
 * (`lib/cli.js` -> `./`), so both candidates are probed once.
 */
let bundlePath: Promise<string> | undefined;
function browserBundle(): Promise<string> {
  bundlePath ??= (async () => {
    const candidates = [new URL('./web.js', import.meta.url), new URL('../lib/web.js', import.meta.url)];
    for (const candidate of candidates) {
      const path = fileURLToPath(candidate);
      try {
        if ((await stat(path)).isFile()) return path;
      } catch { /* Try the next layout. */ }
    }
    throw new TaskError('CLIENT_BUNDLE_MISSING', 'The browser bundle is not built.',
      'Run `node scripts/build.mjs` (or reinstall the package) before using the web UI.');
  })();
  // A failed probe must not be cached, or a later build would need a restart.
  bundlePath.catch(() => { bundlePath = undefined; });
  return bundlePath;
}

export function errorEnvelope(error: unknown): {
  schemaVersion: 1; code: string; message: string; hint: string; details?: unknown;
} {
  if (error instanceof Error) {
    const value = error as Error & { code?: string; hint?: string; details?: unknown };
    return {
      schemaVersion: 1,
      code: typeof value.code === 'string' ? value.code : 'INTERNAL_ERROR',
      message: value.message,
      hint: value.hint || '',
      ...(value.details !== undefined ? { details: value.details } : {}),
    };
  }
  return { schemaVersion: 1, code: 'INTERNAL_ERROR', message: String(error), hint: '' };
}

export function decodeUtf8(content: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw new TaskError('INVALID_UTF8', 'Input must be valid UTF-8.');
  }
}

export async function readUtf8(
  input: AsyncIterable<Uint8Array | string>, limit = INPUT_LIMIT,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new TaskError('INPUT_TOO_LARGE', `Input exceeds ${limit} bytes.`);
    chunks.push(buffer);
  }
  return decodeUtf8(Buffer.concat(chunks));
}

export function parsePlan(content: string): Plan {
  let value: unknown;
  try { value = JSON.parse(content.replace(/^\uFEFF/, '')); }
  catch { throw new TaskError('INVALID_JSON', 'Expected a JSON apply plan.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskError('INVALID_PLAN', 'The apply plan must be an object.');
  }
  const plan = value as Record<string, unknown>;
  if (typeof plan.requestId !== 'string' || !plan.requestId.trim()
    || typeof plan.baseRevision !== 'string' || !Array.isArray(plan.operations)) {
    throw new TaskError('INVALID_PLAN', 'Expected requestId, baseRevision, and operations in the apply plan.');
  }
  return value as Plan;
}

function readBody(request: IncomingMessage): Promise<string> {
  const limit = PLAN_INPUT_LIMIT;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const fail = (error: unknown) => {
      cleanup();
      // An aborted request can emit error after aborted; keep that terminal error handled.
      request.once('error', () => {});
      request.pause();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new TaskError('REQUEST_ABORTED', 'The request was interrupted.'));
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        fail(new TaskError('INPUT_TOO_LARGE', `Input exceeds ${limit} bytes.`));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(decodeUtf8(Buffer.concat(chunks))); }
      catch (error) { reject(error); }
    };
    const declaredLength = request.headers['content-length'];
    if (declaredLength && Number(declaredLength) > limit) {
      fail(new TaskError('INPUT_TOO_LARGE', `Input exceeds ${limit} bytes.`));
      return;
    }
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function errorStatus(code: string): number {
  code = code.toUpperCase();
  if (/NOT_FOUND|ENOENT|MISSING_TASK/.test(code)) return 404;
  if (/CONFLICT|LOCKED|STORE_BUSY|LOCK_LOST|STALE/.test(code)) return 409;
  if (/TOO_LARGE/.test(code)) return 413;
  if (/ORIGIN|FORBIDDEN|HOST|ASSET_ESCAPE/.test(code)) return 403;
  if (/INTERNAL|EIO|EACCES|EPERM/.test(code)) return 500;
  return 400;
}

export async function startServer(
  store: Store, options: { host: string; port: number },
): Promise<{ close(): Promise<void>; url: string }> {
  const { host, port } = options;
  if (!host || /[\s/\\]/.test(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TaskError('INVALID_ADDRESS', 'Expected a host and a port between 0 and 65535.');
  }
  const streams = new Map<ServerResponse, () => void>();
  const sockets = new Set<Socket>();
  let closing: Promise<void> | undefined;
  let boundPort = port;
  const normalizedHost = host.replace(/^\[|\]$/g, '').toLowerCase();
  const allowedHosts = new Set([normalizedHost]);
  if (['127.0.0.1', '::1', 'localhost'].includes(normalizedHost)) {
    for (const name of ['127.0.0.1', '::1', 'localhost']) allowedHosts.add(name);
  }
  const wildcard = normalizedHost === '0.0.0.0' || normalizedHost === '::';
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    void (async () => {
      if (!request.headers.host) throw new TaskError('INVALID_HOST', 'A Host header is required.');
      const origin = new URL(`http://${request.headers.host}`);
      const requestHost = origin.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if ((!wildcard && !allowedHosts.has(requestHost))
        || Number(origin.port || 80) !== boundPort || origin.username || origin.password) {
        throw new TaskError('INVALID_HOST', 'The Host header does not match this server.');
      }
      const url = new URL(request.url || '/', origin);
      if (url.origin !== origin.origin) throw new TaskError('INVALID_HOST', 'Invalid request URL.');
      if (request.method === 'POST') {
        const suppliedOrigin = request.headers.origin;
        if ((suppliedOrigin !== undefined && suppliedOrigin !== origin.origin)
          || request.headers['sec-fetch-site'] === 'cross-site') {
          throw new TaskError('FORBIDDEN_ORIGIN', 'Mutating requests must come from the same origin.');
        }
        if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          throw new TaskError('INVALID_CONTENT_TYPE', 'Use Content-Type: application/json.');
        }
      }
      if (request.method === 'GET' && url.pathname === '/') {
        // The shell loads an external bundle, so inline script is no longer
        // required; styles stay inline because the components render <style>.
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(APP_HTML);
        return;
      }
      if (request.method === 'GET' && url.pathname === APP_SCRIPT_PATH) {
        const script = await readFile(await browserBundle());
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(script);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, await store.state());
        return;
      }
      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && taskMatch) {
        sendJson(response, 200, { schemaVersion: 1, ...await store.read(decodeURIComponent(taskMatch[1]!)) });
        return;
      }
      const assetMatch = /^\/api\/assets\/([^/]+)\/(\d+)$/.exec(url.pathname);
      if (request.method === 'GET' && assetMatch) {
        const index = Number(assetMatch[2]);
        if (!Number.isSafeInteger(index)) throw new TaskError('INVALID_INDEX', 'Asset index is too large.');
        sendJson(response, 200, {
          schemaVersion: 1,
          ...await store.readAsset(decodeURIComponent(assetMatch[1]!), index),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/apply') {
        sendJson(response, 200, await store.apply(parsePlan(await readBody(request))));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
        });
        response.write('retry: 1500\nevent: ready\ndata: {}\n\n');
        let disposed = false;
        let unsubscribe = () => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe();
          streams.delete(response);
        };
        const emit = () => {
          if (!response.destroyed && !response.write('event: change\ndata: {}\n\n')) {
            dispose();
            response.end();
          }
        };
        response.once('close', dispose);
        response.once('error', dispose);
        try {
          unsubscribe = store.subscribe(emit);
          if (disposed) unsubscribe();
          else {
            streams.set(response, dispose);
            heartbeat = setInterval(() => {
              if (!response.destroyed && !response.write(': heartbeat\n\n')) {
                dispose(); response.end();
              }
            }, 20_000);
            heartbeat.unref();
          }
        } catch (error) { dispose(); throw error; }
        return;
      }
      if (!['GET', 'POST'].includes(request.method || '')) {
        response.setHeader('Allow', 'GET, POST');
        sendJson(response, 405, { schemaVersion: 1, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', hint: '' });
        return;
      }
      sendJson(response, 404, { schemaVersion: 1, code: 'NOT_FOUND', message: 'Route not found.', hint: '' });
    })().catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      const envelope = errorEnvelope(error instanceof URIError
        ? new TaskError('INVALID_URL', 'Invalid URL encoding.') : error);
      response.setHeader('Connection', 'close');
      sendJson(response, errorStatus(envelope.code), envelope);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, normalizedHost, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new TaskError('SERVER_ERROR', 'No TCP server address.');
  boundPort = address.port;
  const visibleHost = wildcard ? '127.0.0.1' : normalizedHost;
  const url = `http://${visibleHost.includes(':') ? `[${visibleHost}]` : visibleHost}:${boundPort}`;
  return {
    url,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        for (const [response, dispose] of streams) { dispose(); response.end(); }
        store.close();
        server.close((error) => error ? reject(error) : resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
