import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/core/store.js';
import { APP_HTML, APP_SCRIPT_PATH, startServer } from '../src/server.js';
import { withSandbox } from './helpers.js';

const bundle = fileURLToPath(new URL('../lib/web.js', import.meta.url));

/** The server validates Host/Origin against its own bound address, so start it in the sandbox. */
async function withServer(run: (url: string) => Promise<void>): Promise<void> {
  await withSandbox(async () => {
    const server = await startServer(new Store(), { host: '127.0.0.1', port: 0 });
    try { await run(server.url); }
    finally { await server.close(); }
  });
}

test('the root route serves the app shell under a self-only script policy', async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    const policy = response.headers.get('content-security-policy') ?? '';
    assert.match(policy, /script-src 'self';/);
    assert.doesNotMatch(policy, /script-src 'unsafe-inline'/);
    const html = await response.text();
    assert.equal(html, APP_HTML);
    assert.match(html, new RegExp(`<script src="${APP_SCRIPT_PATH.replace(/\./g, '\\.')}"></script>`));

    // The API and the shell stay same-origin; the mutation guards are unchanged.
    const state = await fetch(`${url}/api/state`);
    assert.equal(state.status, 200);
    assert.equal((await state.json() as { schemaVersion: number }).schemaVersion, 1);
    const crossOrigin = await fetch(`${url}/api/apply`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json() as { code: string }).code, 'FORBIDDEN_ORIGIN');
    const unknownAsset = await fetch(`${url}/assets/other.js`);
    assert.equal(unknownAsset.status, 404);
  });
});

test('the app bundle is served when it has been built', { skip: !existsSync(bundle) && 'lib/web.js is not built' }, async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}${APP_SCRIPT_PATH}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.ok((await response.text()).length > 0);
  });
});
