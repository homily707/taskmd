import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { TaskError, type ApplyResult } from '../src/types.js';
import { withSandbox } from './helpers.js';

/** The Store resolves configuration at construction time, so build it inside the sandbox. */
async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  await withSandbox(async () => {
    const store = new Store();
    try { await run(store); }
    finally { store.close(); }
  });
}

const codes = (error: unknown): string[] =>
  (error instanceof TaskError && Array.isArray(error.details)
    ? (error.details as Array<{ code: string }>).map(entry => entry.code) : []);
const statusOf = async (store: Store, id: string): Promise<string> =>
  (await store.state()).tasks.find(task => task.id === id)!.status;

/** Roots P and X with a leaf under P: the joint acceptance scenario of T5.5/T7. */
async function scenario(store: Store): Promise<{ ids: Record<string, string>; base: ApplyResult }> {
  const state = await store.state();
  const base = await store.apply({
    requestId: 'setup', baseRevision: state.revision,
    operations: [
      { op: 'create', key: 'P', task: { title: 'P' } },
      { op: 'create', key: 'X', task: { title: 'X' } },
      { op: 'create', key: 'leaf', task: { title: 'leaf', parent: { key: 'P' } } },
      { op: 'patch', id: { key: 'P' }, changes: { blocked_by: [{ key: 'X' }] } },
    ],
  });
  return { ids: { ...base.ids } as Record<string, string>, base };
}

test('starting a leaf advances todo ancestors atomically and never re-advances on retry', async () => {
  await withStore(async (store) => {
    const { ids } = await scenario(store);
    const state = await store.state();
    assert.ok(!state.ready.includes(ids.leaf!), 'leaf under a waiting parent is not ready');
    // X is an unblocked root leaf: ready.
    assert.ok(state.ready.includes(ids.X!));

    await store.apply({
      requestId: 'start-x', baseRevision: state.revision,
      operations: [{ op: 'patch', id: ids.X!, changes: { status: 'in_progress' } }],
    });
    assert.equal(await statusOf(store, ids.X!), 'in_progress');
    assert.equal(await statusOf(store, ids.P!), 'todo', 'X only started; P still waits on done');

    // Mark X done, then the leaf becomes ready even while P is still todo.
    let next = await store.state();
    await store.apply({ requestId: 'done-x', baseRevision: next.revision, operations: [{ op: 'patch', id: ids.X!, changes: { status: 'done' } }] });
    next = await store.state();
    assert.ok(next.ready.includes(ids.leaf!), 'leaf is ready once the parent dependency is done');

    await store.apply({
      requestId: 'start-leaf', baseRevision: next.revision,
      operations: [{ op: 'patch', id: ids.leaf!, changes: { status: 'in_progress' } }],
    });
    assert.equal(await statusOf(store, ids.P!), 'in_progress', 'todo ancestors advanced in the same transaction');

    // A repeated start is idempotent: it must not touch statuses again.
    const snap = await store.state();
    const revisionBefore = snap.revision;
    await store.apply({
      requestId: 'start-leaf-retry', baseRevision: revisionBefore,
      operations: [{ op: 'patch', id: ids.leaf!, changes: { status: 'in_progress' } }],
    });
    assert.equal(await statusOf(store, ids.P!), 'in_progress');
    assert.equal(await statusOf(store, ids.leaf!), 'in_progress');
  });
});

test('a parent never completes automatically and must be finished explicitly', async () => {
  await withStore(async (store) => {
    const { ids } = await scenario(store);
    let state = await store.state();
    // Finish X, start and finish the leaf.
    await store.apply({ requestId: 'x-done', baseRevision: state.revision, operations: [{ op: 'patch', id: ids.X!, changes: { status: 'done' } }] });
    state = await store.state();
    await store.apply({ requestId: 'leaf-run', baseRevision: state.revision, operations: [{ op: 'patch', id: ids.leaf!, changes: { status: 'in_progress' } }] });
    state = await store.state();
    await store.apply({ requestId: 'leaf-done', baseRevision: state.revision, operations: [{ op: 'patch', id: ids.leaf!, changes: { status: 'done' } }] });
    assert.equal(await statusOf(store, ids.P!), 'in_progress', 'all children terminal does not complete the parent');

    // Explicit completion succeeds because children are terminal and X is done.
    state = await store.state();
    await store.apply({ requestId: 'p-done', baseRevision: state.revision, operations: [{ op: 'patch', id: ids.P!, changes: { status: 'done' } }] });
    assert.equal(await statusOf(store, ids.P!), 'done');

    // Completing a parent with an unfinished child is rejected.
    state = await store.state();
    const created = await store.apply({ requestId: 'more', baseRevision: state.revision, operations: [
      { op: 'create', key: 'P2', task: { title: 'P2' } },
      { op: 'create', key: 'c1', task: { title: 'c1', parent: { key: 'P2' } } },
      { op: 'create', key: 'c2', task: { title: 'c2', parent: { key: 'P2' } } },
    ]});
    await assert.rejects(
      store.apply({ requestId: 'p2-early', baseRevision: created.revision, operations: [{ op: 'patch', id: created.ids.P2!, changes: { status: 'done' } }] }),
      (error: unknown) => error instanceof TaskError && error.code === 'not_complete',
    );
  });
});

test('adding unfinished work under a done parent requires an explicit reopen in the same plan', async () => {
  await withStore(async (store) => {
    let state = await store.state();
    const created = await store.apply({
      requestId: 'setup', baseRevision: state.revision,
      operations: [
        { op: 'create', key: 'P', task: { title: 'P' } },
        { op: 'create', key: 'c', task: { title: 'c', parent: { key: 'P' } } },
      ],
    });
    state = await store.state();
    await store.apply({ requestId: 'c-done', baseRevision: state.revision, operations: [{ op: 'patch', id: created.ids.c!, changes: { status: 'done' } }] });
    state = await store.state();
    await store.apply({ requestId: 'p-done', baseRevision: state.revision, operations: [{ op: 'patch', id: created.ids.P!, changes: { status: 'done' } }] });

    // Adding an unfinished child without reopening P is a regression.
    state = await store.state();
    await assert.rejects(
      store.apply({ requestId: 'add-under-done', baseRevision: state.revision,
        operations: [{ op: 'create', key: 'new', task: { title: 'new', parent: created.ids.P! } }] }),
      (error: unknown) => error instanceof TaskError && ['not_ready', 'validation_failed'].includes(error.code),
    );

    // The same plan that explicitly reopens P is admitted atomically.
    state = await store.state();
    await store.apply({ requestId: 'reopen-and-add', baseRevision: state.revision, operations: [
      { op: 'patch', id: created.ids.P!, changes: { status: 'in_progress' } },
      { op: 'create', key: 'new', task: { title: 'new', parent: created.ids.P! } },
    ]});
    assert.equal(await statusOf(store, created.ids.P!), 'in_progress');
  });
});

test('canceling cancels unfinished descendants atomically and keeps completed ones', async () => {
  await withStore(async (store) => {
    let state = await store.state();
    const created = await store.apply({
      requestId: 'setup', baseRevision: state.revision,
      operations: [
        { op: 'create', key: 'P', task: { title: 'P' } },
        { op: 'create', key: 'done-child', task: { title: 'done-child', parent: { key: 'P' } } },
        { op: 'create', key: 'todo-child', task: { title: 'todo-child', parent: { key: 'P' } } },
        { op: 'create', key: 'grand', task: { title: 'grand', parent: { key: 'todo-child' } } },
      ],
    });
    state = await store.state();
    await store.apply({ requestId: 'child-done', baseRevision: state.revision, operations: [{ op: 'patch', id: created.ids['done-child']!, changes: { status: 'done' } }] });

    state = await store.state();
    await store.apply({ requestId: 'cancel-p', baseRevision: state.revision, operations: [{ op: 'patch', id: created.ids.P!, changes: { status: 'canceled' } }] });
    assert.equal(await statusOf(store, created.ids.P!), 'canceled');
    assert.equal(await statusOf(store, created.ids['done-child']!), 'done', 'completed descendants keep their result');
    assert.equal(await statusOf(store, created.ids['todo-child']!), 'canceled');
    assert.equal(await statusOf(store, created.ids.grand!), 'canceled', 'unfinished descendants cancel recursively');

    // Canceled ancestors block starting work below them.
    state = await store.state();
    await assert.rejects(
      store.apply({ requestId: 'under-canceled', baseRevision: state.revision, operations: [{ op: 'patch', id: created.ids['done-child']!, changes: { status: 'in_progress' } }] }),
      (error: unknown) => error instanceof TaskError && error.code === 'not_ready',
    );
  });
});

test('same-parent scope: depth alone is not enough, and cycles stay rejected', async () => {
  await withStore(async (store) => {
    let state = await store.state();
    const created = await store.apply({
      requestId: 'setup', baseRevision: state.revision,
      operations: [
        { op: 'create', key: 'A', task: { title: 'A' } },
        { op: 'create', key: 'B', task: { title: 'B' } },
        { op: 'create', key: 'A1', task: { title: 'A1', parent: { key: 'A' } } },
        { op: 'create', key: 'B1', task: { title: 'B1', parent: { key: 'B' } } },
      ],
    });
    // Same depth, different parents: rejected.
    state = await store.state();
    await assert.rejects(
      store.apply({ requestId: 'cross', baseRevision: state.revision, operations: [{ op: 'patch', id: created.ids.A1!, changes: { blocked_by: [created.ids.B1!] } }] }),
      (error: unknown) => error instanceof TaskError && error.code === 'validation_failed' && codes(error).includes('DEPENDENCY_SCOPE'),
    );
    // Self dependency.
    state = await store.state();
    await assert.rejects(
      store.apply({ requestId: 'self', baseRevision: state.revision, operations: [{ op: 'patch', id: created.ids.A!, changes: { blocked_by: [created.ids.A!] } }] }),
      (error: unknown) => error instanceof TaskError && error.code === 'validation_failed' && codes(error).includes('SELF_DEPENDENCY'),
    );
    // Root-level cycle A -> B -> A.
    state = await store.state();
    await store.apply({ requestId: 'ab', baseRevision: state.revision, operations: [{ op: 'patch', id: created.ids.A!, changes: { blocked_by: [created.ids.B!] } }] });
    state = await store.state();
    await assert.rejects(
      store.apply({ requestId: 'ba', baseRevision: state.revision, operations: [{ op: 'patch', id: created.ids.B!, changes: { blocked_by: [created.ids.A!] } }] }),
      (error: unknown) => error instanceof TaskError && error.code === 'validation_failed',
    );
  });
});

test('moving a dependency endpoint across parents is judged on the final graph', async () => {
  await withStore(async (store) => {
    let state = await store.state();
    const created = await store.apply({
      requestId: 'setup', baseRevision: state.revision,
      operations: [
        { op: 'create', key: 'P', task: { title: 'P' } },
        { op: 'create', key: 'Q', task: { title: 'Q' } },
        { op: 'create', key: 'a', task: { title: 'a', parent: { key: 'P' } } },
        { op: 'create', key: 'b', task: { title: 'b', parent: { key: 'P' } } },
        { op: 'patch', id: { key: 'a' }, changes: { blocked_by: [{ key: 'b' }] } },
      ],
    });
    // Moving b under Q alone breaks the edge's scope.
    state = await store.state();
    await assert.rejects(
      store.apply({ requestId: 'move-b-alone', baseRevision: state.revision, operations: [{ op: 'patch', id: created.ids.b!, changes: { parent: created.ids.Q! } }] }),
      (error: unknown) => error instanceof TaskError && error.code === 'validation_failed' && codes(error).includes('DEPENDENCY_SCOPE'),
    );
    // Moving both ends in one plan keeps them siblings and is admitted.
    state = await store.state();
    await store.apply({ requestId: 'move-both', baseRevision: state.revision, operations: [
      { op: 'patch', id: created.ids.a!, changes: { parent: created.ids.Q! } },
      { op: 'patch', id: created.ids.b!, changes: { parent: created.ids.Q! } },
    ]});
  });
});

test('starting a leaf whose ancestor waits is rejected with the blocker named', async () => {
  await withStore(async (store) => {
    const { ids } = await scenario(store);
    const state = await store.state();
    await assert.rejects(
      store.apply({ requestId: 'start-blocked', baseRevision: state.revision, operations: [{ op: 'patch', id: ids.leaf!, changes: { status: 'in_progress' } }] }),
      (error: unknown) => {
        assert.ok(error instanceof TaskError && error.code === 'not_ready');
        assert.ok(codes(error).every(code => code === 'not_ready'));
        const detail = JSON.stringify(error.details);
        assert.ok(detail.includes(ids.X!), `blocker detail names the dependency: ${detail}`);
        return true;
      },
    );
  });
});
