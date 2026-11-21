import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskFiles } from '../src/core/files.js';
import { SessionInboxLauncher, type SessionInboxController } from '../src/dsh/auto-launch.js';

interface Calls {
  created: unknown[];
  prompts: unknown[];
  models: unknown[];
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'taskmd-session-inbox-'));
  const home = join(root, 'home');
  const local = join(root, 'local');
  await mkdir(home);
  const files = new TaskFiles({ localDirectory: local });
  t.after(async () => {
    files.close();
    assert.ok(root.startsWith(join(tmpdir(), 'taskmd-session-inbox-')));
    await rm(root, { recursive: true, force: true });
  });
  await files.init();
  await files.configure({ homeDirectory: home, homeWorkspaceId: 'home-ws', tasksDirectory: 'tasks' });
  return { root, home, local, files, inbox: join(home, 'tasks', 'inbox') };
}

function controller(calls: Calls, catalog?: { groups: { id: string; models: { id: string; reasoning?: { efforts: { id: string }[] } }[] }[] }): SessionInboxController {
  return {
    async create(request) {
      calls.created.push(request);
      return { sessionId: `session-${calls.created.length}` };
    },
    async modelCatalog() { return catalog ?? { groups: [] }; },
    async selectModel(request) { calls.models.push(request); return {}; },
    async prompt(request) { calls.prompts.push(request); return { accepted: true }; },
  };
}

const request = (overrides: Record<string, unknown> = {}) => JSON.stringify({ version: 1, workspaceId: 'home-ws', ...overrides });
const writeRequest = (inbox: string, name: string, body: string) => writeFile(join(inbox, name), body);
const result = async (inbox: string, dir: string, name: string) =>
  JSON.parse(await readFile(join(inbox, dir, `${name.replace(/\.json$/, '')}.result.json`), 'utf8')) as {
    status: string; sessionId?: string; applied: Record<string, boolean>; error?: { code: string; message: string };
  };

test('one JSON request creates exactly one Session and sends its prompt', async t => {
  const f = await fixture(t);
  const calls: Calls = { created: [], prompts: [], models: [] };
  const launcher = new SessionInboxLauncher(f.files, () => controller(calls));
  await writeRequest(f.inbox, 'job.json', request({ prompt: '帮我看看这个仓库' }));

  await launcher.pump();
  assert.deepEqual(calls.created, [{ workspaceId: 'home-ws' }]);
  assert.equal(calls.prompts.length, 1);
  const prompt = calls.prompts[0] as { content: { text: string }[] };
  assert.equal(prompt.content[0]!.text, '帮我看看这个仓库');
  assert.equal((await f.files.state()).tasks.length, 0);
  assert.deepEqual(await f.files.bindings(), []);
  const done = await result(f.inbox, 'done', 'job.json');
  assert.equal(done.status, 'done');
  assert.equal(done.sessionId, 'session-1');
  assert.equal(done.applied.prompted, true);
  await assert.rejects(readFile(join(f.inbox, 'job.json')), { code: 'ENOENT' });

  await launcher.pump();
  assert.equal(calls.created.length, 1);
});

test('a request selects the requested model and rejects an unknown one', async t => {
  const f = await fixture(t);
  const catalog = { groups: [{ id: 'prov', models: [{ id: 'fast', reasoning: { efforts: [{ id: 'high' }] } }] }] };
  const calls: Calls = { created: [], prompts: [], models: [] };
  const launcher = new SessionInboxLauncher(f.files, () => controller(calls, catalog));
  await writeRequest(f.inbox, 'model.json', request({ model: { provider: 'prov', model: 'fast', reasoningEffort: 'high' } }));
  await launcher.pump();
  assert.deepEqual(calls.models, [{ sessionId: 'session-1', provider: 'prov', model: 'fast', reasoningEffort: 'high' }]);

  await writeRequest(f.inbox, 'bad-model.json', request({ model: { provider: 'prov', model: 'missing' } }));
  await launcher.pump();
  assert.equal(calls.created.length, 1);
  const failed = await result(f.inbox, 'failed', 'bad-model.json');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'invalid_model');
});

test('an optional taskId binds the new Session, and an unknown task fails before creation', async t => {
  const f = await fixture(t);
  const task = await f.files.create({ title: 'Bound' });
  const calls: Calls = { created: [], prompts: [], models: [] };
  const launcher = new SessionInboxLauncher(f.files, () => controller(calls));
  await writeRequest(f.inbox, 'bound.json', request({ taskId: task.task.id, prompt: 'go' }));
  await launcher.pump();
  assert.equal(calls.created.length, 1);
  assert.equal((await f.files.bindings())[0]!.sessionId, 'session-1');
  const done = await result(f.inbox, 'done', 'bound.json');
  assert.equal(done.applied.bound, true);

  await writeRequest(f.inbox, 'missing-task.json', request({ taskId: randomUUID() }));
  await launcher.pump();
  assert.equal(calls.created.length, 1);
  const failed = await result(f.inbox, 'failed', 'missing-task.json');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error?.code, 'not_found');
});

test('malformed requests are diagnosed and left in place without creating a Session', async t => {
  const f = await fixture(t);
  const calls: Calls = { created: [], prompts: [], models: [] };
  const launcher = new SessionInboxLauncher(f.files, () => controller(calls));
  await writeRequest(f.inbox, 'bad.json', '{ not json');
  await launcher.pump();
  assert.equal(calls.created.length, 0);
  const state = await f.files.state();
  assert.equal(state.inbox.pending, 0);
  assert.equal(state.inbox.diagnostics.length, 1);
  await assert.doesNotReject(readFile(join(f.inbox, 'bad.json')));
});

test('a request cannot pin the Session title; DSH owns automatic titles', async t => {
  const f = await fixture(t);
  const calls: Calls = { created: [], prompts: [], models: [] };
  const launcher = new SessionInboxLauncher(f.files, () => controller(calls));
  await writeRequest(f.inbox, 'title.json', request({ title: '固定标题' }));
  await launcher.pump();
  assert.equal(calls.created.length, 0);
  const state = await f.files.state();
  assert.equal(state.inbox.diagnostics.length, 1);
  assert.match(state.inbox.diagnostics[0]!.message, /Unknown field: title/);
  await assert.doesNotReject(readFile(join(f.inbox, 'title.json')));
});

test('an interrupted request in processing becomes unknown instead of creating twice', async t => {
  const f = await fixture(t);
  const calls: Calls = { created: [], prompts: [], models: [] };
  await mkdir(join(f.inbox, 'processing'), { recursive: true });
  await writeRequest(join(f.inbox, 'processing'), 'stale.json', request());
  const launcher = new SessionInboxLauncher(f.files, () => controller(calls));
  await launcher.pump();
  assert.equal(calls.created.length, 0);
  const failed = await result(f.inbox, 'failed', 'stale.json');
  assert.equal(failed.status, 'unknown');
});

test('a failed workspace attach records the Session that was already created', async t => {
  const f = await fixture(t);
  const calls: Calls = { created: [], prompts: [], models: [] };
  const launcher = new SessionInboxLauncher(f.files, () => ({
    async create() { throw { code: 'session/workspace-attach-failed', details: { sessionId: 'orphan-1' } }; },
    async prompt() { return { accepted: true }; },
  }));
  await writeRequest(f.inbox, 'attach.json', request());
  await launcher.pump();
  assert.equal(calls.created.length, 0);
  const failed = await result(f.inbox, 'failed', 'attach.json');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.sessionId, 'orphan-1');
});
