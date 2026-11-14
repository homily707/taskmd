import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/core/store.js';
import { TaskError } from '../src/types.js';
import { withSandbox } from './helpers.js';
async function withinStore(run: (store: Store) => Promise<void>) {
  await withSandbox(async () => { const store = new Store(); try { await run(store); } finally { store.close(); } });
}
test('status change affects only its own document', async () => withinStore(async store => {
  const start = await store.state();
  const made = await store.apply({ requestId: 'create', baseRevision: start.revision, operations: [
    { op: 'create', key: 'parent', task: { title: 'P' } },
    { op: 'create', key: 'child', task: { title: 'C', parent: { key: 'parent' } } },
  ] });
  const changed = await store.apply({ requestId: 'cancel', baseRevision: made.revision, operations: [
    { op: 'patch', id: made.ids.parent!, changes: { status: 'canceled' } },
  ] });
  assert.equal((await store.read(made.ids.child!)).task.status, 'todo');
  await store.apply({ requestId: 'run-child', baseRevision: changed.revision, operations: [
    { op: 'patch', id: made.ids.child!, changes: { status: 'in_progress' } },
  ] });
  assert.equal((await store.read(made.ids.parent!)).task.status, 'canceled');
}));
test('unfinished children do not block completion or archive', async () => withinStore(async store => {
  const start = await store.state();
  const made = await store.apply({ requestId: 'create', baseRevision: start.revision, operations: [
    { op: 'create', key: 'P', task: { title: 'P' } },
    { op: 'create', key: 'C', task: { title: 'C', parent: { key: 'P' } } },
  ] });
  const completed = await store.apply({ requestId: 'finish', baseRevision: made.revision, operations: [
    { op: 'patch', id: made.ids.P!, changes: { status: 'done' } },
  ] });
  await store.apply({ requestId: 'archive', baseRevision: completed.revision, operations: [{ op: 'archive', id: made.ids.P! }] });
  assert.equal((await store.read(made.ids.C!)).task.status, 'todo');
  assert.equal((await store.read(made.ids.C!)).task.archived, true);
}));
test('cross-parent links are advisory while parent cycles are invalid', async () => withinStore(async store => {
  const start = await store.state();
  const made = await store.apply({ requestId: 'create', baseRevision: start.revision, operations: [
    { op: 'create', key: 'P', task: { title: 'P' } },
    { op: 'create', key: 'X', task: { title: 'X' } },
    { op: 'create', key: 'C', task: { title: 'C', parent: { key: 'P' } } },
  ] });
  await store.apply({ requestId: 'link', baseRevision: made.revision, operations: [
    { op: 'patch', id: made.ids.C!, changes: { blocked_by: [made.ids.X!, 'missing'] } },
  ] });
  const state = await store.state();
  assert.ok(state.diagnostics.some(issue => issue.code === 'MISSING_DEPENDENCY' && issue.severity === 'warning'));
  await assert.rejects(store.apply({ requestId: 'cycle', baseRevision: state.revision, operations: [
    { op: 'patch', id: made.ids.P!, changes: { parent: made.ids.C! } },
  ] }), (error: unknown) => error instanceof TaskError && error.code === 'validation_failed');
}));
