import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/core/store.js';
import { hash } from '../src/core/document.js';
import type { Operation, Plan, TaskStatus } from '../src/types.js';
import { withSandbox, localStateDirectory, cliJson, runCli } from './helpers.js';

async function apply(store: Store, operations: Operation[]) {
  return store.apply({ requestId: randomUUID(), baseRevision: (await store.state()).revision, operations });
}
const code = (name: string) => (error: unknown) => (error as { code: string }).code === name;
const blocker = (name: string) => (error: unknown) => code('delete_blocked')(error)
  && (error as { details: { code: string }[] }).details.some(item => item.code === name);

for (const status of ['todo', 'in_progress', 'done'] as TaskStatus[]) {
  test(`delete refuses an unarchived ${status} task without modifying it`, async () => withSandbox(async () => {
    const store = new Store();
    try {
      const result = await apply(store, [{ op: 'create', key: 'a', task: { title: 'A', status } }]);
      const before = await store.read(result.ids.a!);
      await assert.rejects(apply(store, [{ op: 'delete', id: result.ids.a! }]), blocker('delete_requires_terminal'));
      assert.equal((await store.read(result.ids.a!)).version, before.version);
      assert.equal((await store.state()).revision, result.revision);
    } finally { store.close(); }
  }));
}

for (const archived of [false, true]) {
  test(`delete removes a ${archived ? 'done archived' : 'canceled'} task and replays idempotently`, async () => withSandbox(async sandbox => {
    const store = new Store();
    try {
      const result = await apply(store, [{ op: 'create', key: 'a', task: { title: 'A', status: archived ? 'done' : 'canceled', archived, assets: [{ kind: 'shared', path: 'note.txt', share: 'task' }] } }]);
      const id = result.ids.a!;
      await writeFile(join(sandbox.store, 'assets', 'note.txt'), 'keep this file');
      await store.bindSession(id, 'keep-this-session');
      const plan: Plan = { requestId: randomUUID(), baseRevision: result.revision, operations: [{ op: 'delete', id, expectedVersion: (await store.read(id)).version }] };
      const deleted = await store.apply(plan);
      assert.notEqual(deleted.revision, result.revision);
      assert.equal(deleted.versions[id], undefined);
      assert.equal((await store.state()).tasks.length, 0);
      assert.deepEqual((await store.metadataState()).tasks, []);
      assert.deepEqual(await store.listSessionBindings(), []);
      assert.equal(await readFile(join(sandbox.store, 'assets', 'note.txt'), 'utf8'), 'keep this file');
      await assert.rejects(store.read(id), code('task_not_found'));
      assert.deepEqual(JSON.parse(JSON.stringify(await store.apply(plan))), JSON.parse(JSON.stringify(deleted)));
    } finally { store.close(); }
  }));
}

test('both dependency directions block deletion, including archived tasks', async () => withSandbox(async () => {
  const store = new Store();
  try {
    const result = await apply(store, [
      { op: 'create', key: 'a', task: { title: 'A', status: 'done', archived: true } },
      { op: 'create', key: 'b', task: { title: 'B', status: 'canceled', archived: true, blocked_by: [{ key: 'a' }] } },
    ]);
    await assert.rejects(apply(store, [{ op: 'delete', id: result.ids.a! }]), blocker('delete_has_dependents'));
    await assert.rejects(apply(store, [{ op: 'delete', id: result.ids.b! }]), blocker('delete_has_dependencies'));
    await apply(store, [
      { op: 'patch', id: result.ids.b!, changes: { blocked_by: [] } },
      { op: 'delete', id: result.ids.a! },
    ]);
    assert.deepEqual((await store.state()).tasks.map(task => task.id), [result.ids.b]);
    assert.deepEqual((await store.read(result.ids.b!)).task.blocked_by, []);
  } finally { store.close(); }
}));

test('parents require explicit child deletion or movement, and a refused batch writes nothing', async () => withSandbox(async () => {
  const store = new Store();
  try {
    const result = await apply(store, [
      { op: 'create', key: 'a', task: { title: 'A', status: 'canceled' } },
      { op: 'create', key: 'b', task: { title: 'B', status: 'canceled', parent: { key: 'a' } } },
    ]);
    await assert.rejects(apply(store, [{ op: 'delete', id: result.ids.a! }]), blocker('delete_has_children'));
    await assert.rejects(apply(store, [{ op: 'delete', id: result.ids.b! }, { op: 'delete', id: 'missing' }]), code('task_not_found'));
    assert.equal((await store.state()).tasks.length, 2);
    await apply(store, [{ op: 'delete', id: result.ids.b! }, { op: 'delete', id: result.ids.a! }]);
    assert.equal((await store.state()).tasks.length, 0);
  } finally { store.close(); }
}));

test('deletion rejects stale task versions and stale whole-store revisions', async () => withSandbox(async () => {
  const store = new Store();
  try {
    const result = await apply(store, [{ op: 'create', key: 'a', task: { title: 'A', status: 'canceled' } }]);
    const id = result.ids.a!;
    await assert.rejects(apply(store, [{ op: 'delete', id, expectedVersion: 'old' }]), code('version_conflict'));
    await apply(store, [{ op: 'patch', id, changes: { title: 'changed' } }]);
    await assert.rejects(store.apply({ requestId: randomUUID(), baseRevision: result.revision, operations: [{ op: 'delete', id }] }), code('version_conflict'));
    assert.equal((await store.read(id)).task.title, 'changed');
  } finally { store.close(); }
}));

for (const alreadyRemoved of [false, true]) {
  test(`recovery completes a deletion journal (file already removed=${alreadyRemoved}) and clears bindings`, async () => withSandbox(async sandbox => {
    const store = new Store();
    try {
      const created = await apply(store, [{ op: 'create', key: 'a', task: { title: 'A', status: 'canceled' } }]);
      const id = created.ids.a!;
      const record = await store.read(id);
      await store.bindSession(id, 'session-1');
      const plan: Plan = { requestId: randomUUID(), baseRevision: created.revision, operations: [{ op: 'delete', id }] };
      const result = { schemaVersion: 1, requestId: plan.requestId, revision: hash(JSON.stringify([])), ids: {}, versions: {} };
      const local = await localStateDirectory(sandbox);
      await writeFile(join(local, 'pending.json'), JSON.stringify({ schema: 1, requestId: plan.requestId, digest: hash(JSON.stringify(plan)), entries: [{ id, before: record.content, after: null }], result }));
      const taskPath = join(sandbox.store, 'tasks', `${id}.md`);
      assert.ok(taskPath.startsWith(`${sandbox.base}/store/tasks/`));
      if (alreadyRemoved) await unlink(taskPath);
      assert.deepEqual((await store.state()).tasks, []);
      assert.deepEqual(await store.listSessionBindings(), []);
      assert.deepEqual(await store.apply(plan), result);
      await assert.rejects(readFile(join(local, 'pending.json')), code('ENOENT'));
    } finally { store.close(); }
  }));
}

test('recovery refuses to erase an externally edited task', async () => withSandbox(async sandbox => {
  const store = new Store();
  try {
    const created = await apply(store, [{ op: 'create', key: 'a', task: { title: 'A', status: 'canceled' } }]);
    const id = created.ids.a!, record = await store.read(id), requestId = randomUUID();
    const local = await localStateDirectory(sandbox);
    await writeFile(join(local, 'pending.json'), JSON.stringify({ schema: 1, requestId, digest: 'digest', entries: [{ id, before: record.content, after: null }], result: { schemaVersion: 1, requestId, revision: hash(JSON.stringify([])), ids: {}, versions: {} } }));
    const path = join(sandbox.store, 'tasks', `${id}.md`);
    await writeFile(path, `${record.content}\nExternal edit\n`);
    await assert.rejects(store.state(), code('version_conflict'));
    assert.match(await readFile(path, 'utf8'), /External edit/);
  } finally { store.close(); }
}));

test('CLI delete applies the same prerequisites and supports --if-version', async () => withSandbox(async sandbox => {
  const created = await cliJson(sandbox, ['create', 'delete me']);
  const id = created.ids.task;
  const refused = await runCli(sandbox, ['--json', 'delete', id]);
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.stderr).code, 'delete_blocked');
  await cliJson(sandbox, ['status', id, 'canceled']);
  const record = await cliJson(sandbox, ['show', id]);
  await cliJson(sandbox, ['delete', id, '--if-version', record.version]);
  assert.deepEqual((await cliJson(sandbox, ['list'])).tasks, []);
}));
