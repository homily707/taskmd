import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskFiles } from '../src/core/files.js';
import { createDocument } from '../src/core/document.js';
import { InboxAutoLauncher, type AutoLaunchSessionController } from '../src/dsh/auto-launch.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'taskmd-auto-launch-'));
  const home = join(root, 'home');
  const local = join(root, 'local');
  await mkdir(home);
  const files = new TaskFiles({ localDirectory: local });
  t.after(async () => {
    files.close();
    assert.ok(root.startsWith(join(tmpdir(), 'taskmd-auto-launch-')));
    await rm(root, { recursive: true, force: true });
  });
  await files.init();
  await files.configure({ homeDirectory: home, homeWorkspaceId: 'home-ws', tasksDirectory: 'tasks' });
  return { root, home, local, files };
}

function controller(calls: { created: unknown[]; prompts: unknown[] }): AutoLaunchSessionController {
  return {
    async create(request) {
      calls.created.push(request);
      return { sessionId: `session-${calls.created.length}` };
    },
    async prompt(request) {
      calls.prompts.push(request);
      return { accepted: true };
    },
  };
}

test('inbox launch creates, binds, and sends exactly one task snapshot per file', async t => {
  const f = await fixture(t);
  const calls = { created: [] as unknown[], prompts: [] as unknown[] };
  const launcher = new InboxAutoLauncher(f.files, f.local, () => controller(calls));
  await writeFile(join(f.home, 'tasks', 'inbox', 'Auto task.md'), '---\ntaskmd: 0.3\ntitle: Auto task\n---\n\nImplement the thing.\n');

  await launcher.pump();
  let state = await f.files.state();
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0]!.task.title, 'Auto task');
  assert.equal(state.inbox.pending, 0);
  assert.deepEqual(calls.created, [{ workspaceId: 'home-ws' }]);
  assert.equal((await f.files.bindings()).length, 1);
  assert.equal((await f.files.bindings())[0]!.sessionId, 'session-1');
  assert.equal(calls.prompts.length, 1);
  const prompt = calls.prompts[0] as { text?: string; content?: { text: string }[] };
  assert.match(prompt.content?.[0]?.text ?? '', /Auto task/);
  assert.match(prompt.content?.[0]?.text ?? '', /action=read/);
  assert.doesNotMatch(prompt.content?.[0]?.text ?? '', /Implement the thing/);

  await launcher.pump();
  assert.equal(calls.created.length, 1);
  assert.equal(calls.prompts.length, 1);
  state = await f.files.state();
  assert.equal(state.tasks.length, 1);
});

test('inbox launch skips malformed files and does not create any Session', async t => {
  const f = await fixture(t);
  const calls = { created: [] as unknown[], prompts: [] as unknown[] };
  const launcher = new InboxAutoLauncher(f.files, f.local, () => controller(calls));
  await writeFile(join(f.home, 'tasks', 'inbox', 'bad.md'), '---\ntaskmd: 0.3\nid: not-a-uuid\n---\n');

  await launcher.pump();
  assert.equal(calls.created.length, 0);
  assert.equal(calls.prompts.length, 0);
  const state = await f.files.state();
  assert.equal(state.tasks.length, 0);
  assert.equal(state.inbox.pending, 0);
  assert.equal(state.inbox.diagnostics.length, 1);
});

test('a completed launch record is not replayed by a new launcher instance', async t => {
  const f = await fixture(t);
  const first = { created: [] as unknown[], prompts: [] as unknown[] };
  const launcher = new InboxAutoLauncher(f.files, f.local, () => controller(first));
  const task = createDocument({ id: randomUUID(), title: 'Once', status: 'todo', parent: null, order: 0, archived: false, body: 'Only once.' });
  await writeFile(join(f.home, 'tasks', 'inbox', 'once.md'), task);
  await launcher.pump();
  assert.equal(first.created.length, 1);

  const second = { created: [] as unknown[], prompts: [] as unknown[] };
  const restarted = new InboxAutoLauncher(f.files, f.local, () => controller(second));
  await restarted.pump();
  assert.equal(second.created.length, 0);
  assert.equal(second.prompts.length, 0);
  assert.ok(JSON.parse(await readFile(join(f.local, 'auto-launch.json'), 'utf8')));
});

test('an inbox file duplicating an existing task never launches another Session', async t => {
  const f = await fixture(t);
  const existing = await f.files.create({ title: 'Existing' });
  await writeFile(join(f.home, 'tasks', 'inbox', 'copy.md'), existing.content);
  const calls = { created: [] as unknown[], prompts: [] as unknown[] };
  const launcher = new InboxAutoLauncher(f.files, f.local, () => controller(calls));
  await launcher.pump();
  assert.equal(calls.created.length, 0);
  assert.equal(calls.prompts.length, 0);
  assert.equal((await f.files.state()).tasks.length, 1);
  await assert.doesNotReject(readFile(join(f.home, 'tasks', 'inbox', 'copy.md')));
});
