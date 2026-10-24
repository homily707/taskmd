import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { TaskError } from '../src/types.js';
import { withSandbox, localStateDirectory } from './helpers.js';

/** The Store resolves configuration at construction time, so build it inside the sandbox. */
async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  await withSandbox(async () => {
    const store = new Store();
    try { await run(store); }
    finally { store.close(); }
  });
}

async function createOne(store: Store, title = '任务'): Promise<{ id: string; revision: string }> {
  const state = await store.state();
  const result = await store.apply({
    requestId: `req-${title}-${Date.now()}`,
    baseRevision: state.revision,
    operations: [{ op: 'create', key: 'a', task: { title } }],
  });
  return { id: result.ids.a!, revision: result.revision };
}

test('apply creates a task with frontmatter and reports the new revision', async () => {
  await withStore(async (store) => {
    const before = await store.state();
    assert.deepEqual(before.tasks, []);
    const { id, revision } = await createOne(store, '写冒烟测试');
    assert.match(id, /^task-[0-9a-f-]{36}$/);
    assert.notEqual(revision, before.revision);

    const record = await store.read(id);
    assert.equal(record.task.title, '写冒烟测试');
    assert.equal(record.task.status, 'todo');
    assert.equal(record.task.parent, null);
    assert.deepEqual(record.task.blocked_by, []);
    assert.match(record.content, /^---\n/);
    assert.match(record.content, new RegExp(`id: ${id}`));

    const after = await store.state();
    assert.equal(after.revision, revision);
    assert.deepEqual(after.tasks.map((task) => task.id), [id]);
    assert.deepEqual(after.diagnostics, []);
    assert.deepEqual(after.ready, [id]);
  });
});

test('apply is idempotent per requestId and rejects reuse with different content', async () => {
  await withStore(async (store) => {
    const state = await store.state();
    const plan = {
      requestId: 'fixed-request-id',
      baseRevision: state.revision,
      operations: [{ op: 'create' as const, key: 'a', task: { title: '幂等' } }],
    };
    const first = await store.apply(plan);
    const replay = await store.apply(plan);
    // `ids`/`versions` are null-prototype maps, so compare them as plain JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(replay)), JSON.parse(JSON.stringify(first)));
    assert.deepEqual(Object.keys(replay.ids), ['a']);

    await assert.rejects(
      store.apply({ ...plan, operations: [{ op: 'create', key: 'a', task: { title: '改了' } }] }),
      (error: unknown) => error instanceof TaskError && error.code === 'request_reused',
    );
  });
});

test('parents may declare same-parent dependencies; cross-parent and dangling refs fail validation', async () => {
  await withStore(async (store) => {
    const state = await store.state();
    const result = await store.apply({
      requestId: 'tree-1',
      baseRevision: state.revision,
      operations: [
        { op: 'create', key: 'parent', task: { title: '父' } },
        { op: 'create', key: 'child', task: { title: '子', parent: { key: 'parent' } } },
        { op: 'create', key: 'leaf', task: { title: '叶子' } },
      ],
    });
    assert.equal(Object.keys(result.ids).length, 3);

    // T7: a parent may depend on same-parent siblings (both are roots here).
    const allowed = await store.apply({
      requestId: 'tree-2',
      baseRevision: result.revision,
      operations: [{ op: 'patch', id: result.ids.parent!, changes: { blocked_by: [result.ids.leaf!] } }],
    });
    assert.ok(allowed.versions[result.ids.parent!] !== undefined);

    // Cross-parent direct dependencies are scope errors (child under parent vs. root leaf).
    await assert.rejects(
      store.apply({
        requestId: 'tree-2b',
        baseRevision: allowed.revision,
        operations: [{ op: 'patch', id: result.ids.child!, changes: { blocked_by: [result.ids.leaf!] } }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof TaskError && error.code === 'validation_failed');
        const codes = (error.details as Array<{ code: string }>).map((entry) => entry.code);
        assert.ok(codes.includes('DEPENDENCY_SCOPE'), `unexpected diagnostics: ${codes.join(', ')}`);
        return true;
      },
    );

    // Unknown dependency IDs are validation errors too.
    const afterScope = await store.state();
    await assert.rejects(
      store.apply({
        requestId: 'tree-3',
        baseRevision: afterScope.revision,
        operations: [{ op: 'patch', id: result.ids.leaf!, changes: { blocked_by: ['task-missing'] } }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof TaskError && error.code === 'validation_failed');
        const codes = (error.details as Array<{ code: string }>).map((entry) => entry.code);
        assert.ok(codes.includes('MISSING_DEPENDENCY'), `unexpected diagnostics: ${codes.join(', ')}`);
        return true;
      },
    );
  });
});

test('version_conflict: stale baseRevision and stale expectedVersion are rejected', async () => {
  await withStore(async (store) => {
    const state = await store.state();
    const created = await store.apply({
      requestId: 'conflict-create',
      baseRevision: state.revision,
      operations: [{ op: 'create', key: 'a', task: { title: '冲突' } }],
    });
    const id = created.ids.a!;
    const record = await store.read(id);

    // A plan prepared against an outdated revision must not silently overwrite.
    await assert.rejects(
      store.apply({
        requestId: 'conflict-revision',
        baseRevision: state.revision,
        operations: [{ op: 'patch', id, changes: { title: '过期 revision' } }],
      }),
      (error: unknown) => error instanceof TaskError && error.code === 'version_conflict',
    );

    // A Markdown replacement or patch carrying an outdated file version must fail too.
    await assert.rejects(
      store.apply({
        requestId: 'conflict-version',
        baseRevision: created.revision,
        operations: [{ op: 'patch', id, changes: { title: '过期 version' }, expectedVersion: 'deadbeef' }],
      }),
      (error: unknown) => error instanceof TaskError && error.code === 'version_conflict',
    );

    await assert.rejects(
      store.apply({
        requestId: 'conflict-markdown',
        baseRevision: created.revision,
        operations: [{ op: 'replaceMarkdown', id, content: record.content, expectedVersion: 'deadbeef' }],
      }),
      (error: unknown) => error instanceof TaskError && error.code === 'version_conflict',
    );

    // The task is untouched by the rejected plans.
    assert.equal((await store.read(id)).task.title, '冲突');
    assert.equal((await store.read(id)).version, record.version);
  });
});

test('bindSession and unbindSession write sessions.json and are idempotent', async () => {
  await withSandbox(async (sandbox) => {
    const store = new Store();
    try {
      const { id } = await createOne(store);
      await store.bindSession(id, 'session-1');
      await store.bindSession(id, 'session-1');
      await store.bindSession(id, 'session-2');

      const local = await localStateDirectory(sandbox);
      const file = join(local, 'sessions.json');
      const bindings = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
      assert.equal(bindings.length, 2);
      assert.deepEqual(bindings.map((binding) => binding.sessionId), ['session-1', 'session-2']);
      const instanceId = (JSON.parse(await readFile(join(local, 'instance.json'), 'utf8')) as { instanceId: string }).instanceId;
      for (const binding of bindings) {
        assert.equal(binding.provider, 'dsh');
        assert.equal(binding.taskId, id);
        assert.equal(binding.instanceId, instanceId);
        assert.equal(typeof binding.createdAt, 'string');
      }

      const listed = await store.listSessionBindings({ taskId: id });
      assert.deepEqual(listed.map((b) => b.sessionId), ['session-1', 'session-2']);
      // A repeated bind keeps the identity but refreshes the touch time.
      assert.equal(typeof listed[0]!.lastOpenedAt, 'string');
      assert.deepEqual((await store.listSessionBindings({ sessionId: 'session-2' })).map((b) => b.taskId), [id]);

      await store.unbindSession(id, 'session-1');
      await store.unbindSession(id, 'session-1');
      assert.deepEqual((await store.listSessionBindings()).map((b) => b.sessionId), ['session-2']);

      await store.unbindSession(id, 'session-2');
      assert.deepEqual(await store.listSessionBindings(), []);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), []);
    } finally { store.close(); }
  });
});

test('touchSessionBinding records opens without creating or moving rows', async () => {
  await withSandbox(async (sandbox) => {
    const store = new Store();
    try {
      const { id } = await createOne(store);
      // No binding yet: an open is not a binding request, so nothing is written.
      assert.equal(await store.touchSessionBinding('session-1'), false);
      assert.deepEqual(await store.listSessionBindings(), []);

      await store.bindSession(id, 'session-1');
      const created = (await store.listSessionBindings())[0]!;
      // A fresh row has no touch time; only an open records one.
      assert.equal(created.lastOpenedAt, undefined);

      assert.equal(await store.touchSessionBinding('session-1'), true);
      const opened = (await store.listSessionBindings())[0]!;
      assert.equal(typeof opened.lastOpenedAt, 'string');
      assert.equal(opened.createdAt, created.createdAt);
      assert.equal(opened.taskId, id);

      const local = await localStateDirectory(sandbox);
      const bindings = JSON.parse(await readFile(join(local, 'sessions.json'), 'utf8')) as Array<Record<string, unknown>>;
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0]!.lastOpenedAt, opened.lastOpenedAt);

      // Touching an unrelated Session changes nothing.
      assert.equal(await store.touchSessionBinding('session-unknown'), false);
      assert.equal((await store.listSessionBindings()).length, 1);

      // Task Markdown is never touched by an open.
      assert.equal((await store.read(id)).task.title, '任务');
    } finally { store.close(); }
  });
});

test('touchSessionBinding records opens even after the Task is archived', async () => {
  await withStore(async (store) => {
    const { id } = await createOne(store);
    await store.bindSession(id, 'session-1');
    const state = await store.state();
    await store.apply({
      requestId: 'finish-it',
      baseRevision: state.revision,
      operations: [{ op: 'patch', id, changes: { status: 'done' } }],
    });
    const finished = await store.state();
    await store.apply({ requestId: 'archive-it', baseRevision: finished.revision, operations: [{ op: 'archive', id }] });
    assert.equal((await store.read(id)).task.archived, true);

    // Opening must not depend on the Task file: an archived Task still opens.
    assert.equal(await store.touchSessionBinding('session-1'), true);
    const binding = (await store.listSessionBindings({ taskId: id }))[0]!;
    assert.equal(typeof binding.lastOpenedAt, 'string');
    // The archive is untouched by the open.
    assert.equal((await store.read(id)).task.archived, true);
  });
});

test('touchSessionBinding rejects an invalid session ID and a foreign instance', async () => {
  await withStore(async (store) => {
    const { id } = await createOne(store);
    await store.bindSession(id, 'session-1');
    await assert.rejects(
      store.touchSessionBinding('   '),
      (error: unknown) => error instanceof TaskError && error.code === 'invalid_session',
    );
    // Another machine's rows are not visible from here, so nothing is touched.
    assert.equal(await store.touchSessionBinding('session-1', { instanceId: 'other-machine' }), false);
    assert.equal((await store.listSessionBindings())[0]!.lastOpenedAt, undefined);
  });
});

test('instances are stable across stores and reused for later bindings', async () => {
  await withSandbox(async (sandbox) => {
    const first = new Store();
    let instanceId: string;
    try {
      const { id } = await createOne(first);
      await first.bindSession(id, 'session-a');
      instanceId = (await first.listSessionBindings())[0]!.instanceId;
      assert.match(instanceId, /^[0-9a-f-]{36}$/);
      // A second Store over the same local state adopts the recorded identity.
      assert.equal((await first.listSessionBindings())[0]!.instanceId, instanceId);
    } finally { first.close(); }

    const second = new Store();
    try {
      assert.equal((await second.listSessionBindings())[0]!.instanceId, instanceId);
      const file = join(await localStateDirectory(sandbox), 'instance.json');
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { instanceId });
    } finally { second.close(); }
  });
});

test('legacy sessions.json without instanceId is read and migrated on the next write', async () => {
  await withSandbox(async (sandbox) => {
    const store = new Store();
    try {
      const { id } = await createOne(store);
      const local = await localStateDirectory(sandbox);
      const file = join(local, 'sessions.json');
      await writeFile(file, JSON.stringify([{
        provider: 'dsh', taskId: id, sessionId: 'legacy-1', createdAt: '2024-01-01T00:00:00.000Z',
      }], null, 2), 'utf8');

      // Reading accepts the old shape and attributes the row to this machine.
      const listed = await store.listSessionBindings({ taskId: id });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.sessionId, 'legacy-1');
      assert.match(listed[0]!.instanceId, /^[0-9a-f-]{36}$/);
      // Reading alone does not rewrite the file.
      assert.equal((JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>)[0]!.instanceId, undefined);

      // Any write persists the migrated format for every row.
      await store.bindSession(id, 'legacy-2');
      const migrated = JSON.parse(await readFile(file, 'utf8')) as Array<Record<string, unknown>>;
      assert.equal(migrated.length, 2);
      for (const binding of migrated) assert.equal(binding.instanceId, listed[0]!.instanceId);
    } finally { store.close(); }
  });
});

test('a session already bound to another task is rejected, not silently moved', async () => {
  await withStore(async (store) => {
    const first = await createOne(store, '第一个任务');
    const second = await createOne(store, '第二个任务');
    await store.bindSession(first.id, 'shared-session');

    await assert.rejects(
      store.bindSession(second.id, 'shared-session'),
      (error: unknown) => {
        assert.ok(error instanceof TaskError);
        assert.equal(error.code, 'session_already_bound');
        const details = error.details as Record<string, unknown>;
        assert.equal(details.taskId, second.id);
        assert.equal(details.existingTaskId, first.id);
        assert.equal(details.sessionId, 'shared-session');
        assert.equal(typeof details.instanceId, 'string');
        return true;
      },
    );

    // The original binding survives and the second task gained nothing.
    assert.deepEqual((await store.listSessionBindings({ sessionId: 'shared-session' })).map((b) => b.taskId), [first.id]);
    assert.deepEqual(await store.listSessionBindings({ taskId: second.id }), []);

    // Unbinding the owner frees the identity for a confirmed rebind.
    await store.unbindSession(first.id, 'shared-session');
    await store.bindSession(second.id, 'shared-session');
    assert.deepEqual((await store.listSessionBindings({ sessionId: 'shared-session' })).map((b) => b.taskId), [second.id]);
  });
});

test('binding and unbinding never change task status, dependencies, or the tree', async () => {
  await withStore(async (store) => {
    const parent = await createOne(store, '父任务');
    const state = await store.state();
    const created = await store.apply({
      requestId: 'child-with-dependency',
      baseRevision: state.revision,
      operations: [{ op: 'create', key: 'b', task: { title: '子任务' } }],
    });
    const childId = created.ids.b!;
    const before = await store.read(childId);

    await store.bindSession(childId, 'session-x');
    await store.bindSession(childId, 'session-y');
    await store.unbindSession(childId, 'session-x');
    const after = await store.read(childId);

    assert.equal(after.task.status, before.task.status);
    assert.deepEqual(after.task.blocked_by, before.task.blocked_by);
    assert.equal(after.task.parent, before.task.parent);
    assert.equal(after.task.id, before.task.id);
    assert.equal(after.version, before.version);
    assert.equal((await store.read(parent.id)).task.status, 'todo');
  });
});

test('bindings support provider and instanceId filters and full-identity unbind', async () => {
  await withStore(async (store) => {
    const { id } = await createOne(store);
    await store.bindSession(id, 'local-session');
    const instanceId = (await store.listSessionBindings())[0]!.instanceId;

    await store.bindSession(id, 'remote-session', { instanceId: 'other-machine' });
    assert.deepEqual((await store.listSessionBindings()).map((b) => b.sessionId), ['local-session', 'remote-session']);
    assert.deepEqual((await store.listSessionBindings({ instanceId })).map((b) => b.sessionId), ['local-session']);
    assert.deepEqual((await store.listSessionBindings({ provider: 'dsh' })).map((b) => b.sessionId), ['local-session', 'remote-session']);
    assert.deepEqual(await store.listSessionBindings({ provider: 'other' }), []);

    // An omitted instanceId unbinds this machine's row and leaves the other alone.
    await store.unbindSession(id, 'local-session');
    assert.deepEqual((await store.listSessionBindings()).map((b) => b.sessionId), ['remote-session']);
    await store.unbindSession(id, 'remote-session', { instanceId: 'other-machine' });
    assert.deepEqual(await store.listSessionBindings(), []);
  });
});

test('bindSession rejects unknown tasks and empty session IDs', async () => {
  await withStore(async (store) => {
    await assert.rejects(
      store.bindSession('task-does-not-exist', 'session-1'),
      (error: unknown) => error instanceof TaskError && error.code === 'task_not_found',
    );
    const { id } = await createOne(store);
    await assert.rejects(
      store.bindSession(id, '   '),
      (error: unknown) => error instanceof TaskError && error.code === 'invalid_session',
    );
    await assert.rejects(
      store.bindSession(id, 'session-1', { instanceId: '  ' }),
      (error: unknown) => error instanceof TaskError && error.code === 'invalid_instance',
    );
    await assert.rejects(
      store.bindSession(id, 'session-1', { provider: '' }),
      (error: unknown) => error instanceof TaskError && error.code === 'invalid_provider',
    );
  });
});

test('corrupted sessions.json surfaces invalid_local_data', async () => {
  await withSandbox(async (sandbox) => {
    const store = new Store();
    try {
      await createOne(store);
      const file = join(await localStateDirectory(sandbox), 'sessions.json');
      await writeFile(file, '{not json', 'utf8');
      await assert.rejects(
        store.listSessionBindings(),
        (error: unknown) => error instanceof TaskError && error.code === 'invalid_local_data',
      );

      // Well-formed JSON with the wrong shape is corruption as well.
      await writeFile(file, JSON.stringify([{ provider: 'dsh', taskId: 'x' }]), 'utf8');
      await assert.rejects(
        store.listSessionBindings(),
        (error: unknown) => error instanceof TaskError && error.code === 'invalid_local_data',
      );
    } finally { store.close(); }
  });
});

test('corrupted repositories.json surfaces invalid_local_data', async () => {
  await withSandbox(async (sandbox) => {
    const store = new Store();
    try {
      await createOne(store);
      const file = join(await localStateDirectory(sandbox), 'repositories.json');
      await writeFile(file, JSON.stringify({ backend: 'relative/path' }), 'utf8');
      await assert.rejects(
        store.reposList(),
        (error: unknown) => error instanceof TaskError && error.code === 'invalid_local_data',
      );
    } finally { store.close(); }
  });
});
