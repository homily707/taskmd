import test from 'node:test';
import assert from 'node:assert/strict';
import type { Operation, Task } from '../src/types.js';
import { indentOperations, moveOperations, outlineRows } from '../src/ui/outline-model.js';

let counter = 0;
const task = (over: Partial<Task> & { id: string; title?: string }): Task => ({
  schema: 1, title: over.id, status: 'todo', parent: null, blocked_by: [], order: `a${(counter++).toString().padStart(3, '0')}`,
  repo: null, assets: [], archived: false, body: '', ...over,
});
const opId = (operation: Operation): string => typeof (operation as { id?: unknown }).id === 'string' ? (operation as { id: string }).id : '';
const sortIds = (operations: Operation[]) => operations.map(opId).filter(Boolean).sort();

test('reordering siblings rewrites the affected order keys and keeps parents', () => {
  const tasks = [task({ id: 'A' }), task({ id: 'B' }), task({ id: 'C' })];
  const operations = moveOperations(tasks, 'C', 'A', 'before');
  assert.deepEqual(operations.map(operation => (operation as { id: string }).id), ['C', 'A', 'B']);
  for (const operation of operations) {
    assert.equal(operation.op, 'patch');
    if (operation.op !== 'patch') continue;
    if ('parent' in operation.changes) assert.equal(operation.changes.parent, null);
  }
});

test('moving into a task reparents it and reorders the destination siblings', () => {
  const tasks = [task({ id: 'P' }), task({ id: 'X', parent: 'P' }), task({ id: 'Y', parent: 'P' }), task({ id: 'Q' })];
  const operations = moveOperations(tasks, 'Q', 'P', 'inside');
  const moved = operations.find(operation => operation.op === 'patch' && operation.id === 'Q');
  assert.equal(moved && JSON.stringify((moved as { changes: { parent: string | null } }).changes.parent), '"P"');
  assert.deepEqual(sortIds(operations), ['Q', 'X', 'Y']);
});

test('moving a task into its own descendant is rejected', () => {
  const tasks = [task({ id: 'A' }), task({ id: 'B', parent: 'A' }), task({ id: 'C', parent: 'B' })];
  assert.throws(() => moveOperations(tasks, 'A', 'C', 'inside'), /自身或后代/);
  assert.throws(() => moveOperations(tasks, 'A', 'A', 'after'), /自身或后代/);
});

test('a move that would break another task incoming dependency is rejected with the edge named', () => {
  // E stays at the root while D moves under P: the E→D edge would cross parents.
  const tasks = [
    task({ id: 'P' }), task({ id: 'D' }), task({ id: 'E', blocked_by: ['D'] }),
  ];
  assert.throws(() => moveOperations(tasks, 'D', 'P', 'inside'), /跨父依赖/);
  // Moving both ends to the same parent is fine, and no other edge exists here.
  const clean = [task({ id: 'P' }), task({ id: 'D' }), task({ id: 'E', parent: 'P' })];
  assert.doesNotThrow(() => moveOperations(clean, 'D', 'P', 'inside'));
});

test('outgoing dependency edges are checked as well', () => {
  // D depends on E under Q; moving D under P would leave the edge across parents.
  const tasks = [
    task({ id: 'P' }), task({ id: 'Q' }), task({ id: 'E', parent: 'Q' }), task({ id: 'D', blocked_by: ['E'] }),
  ];
  assert.throws(() => moveOperations(tasks, 'D', 'P', 'inside'), /跨父依赖/);
});

test('indent uses the previous sibling as the new parent; outdent follows the current parent', () => {
  const tasks = [task({ id: 'A' }), task({ id: 'B' }), task({ id: 'C' }), task({ id: 'D', parent: 'C' })];
  const indented = indentOperations(tasks, 'C', false);
  const moved = indented.find(operation => operation.op === 'patch' && operation.id === 'C') as { changes: { parent: string | null } };
  assert.equal(moved.changes.parent, 'B');
  const outdented = indentOperations(tasks, 'D', true);
  const back = outdented.find(operation => operation.op === 'patch' && operation.id === 'D') as { changes: { parent: string | null } };
  assert.equal(back.changes.parent, null);
});

test('indent fails without a previous sibling and outdent fails at the root', () => {
  const tasks = [task({ id: 'A' }), task({ id: 'B', parent: 'A' })];
  assert.throws(() => indentOperations(tasks, 'A', false), /前一个同级/);
  assert.throws(() => indentOperations(tasks, 'A', true), /根任务/);
});

test('outline rows follow order and depth; collapsed subtrees hide descendants only', () => {
  const tasks = [
    task({ id: 'R1' }), task({ id: 'A', parent: 'R1' }), task({ id: 'A1', parent: 'A' }),
    task({ id: 'R2' }), task({ id: 'B', parent: 'R2' }),
  ];
  const open = outlineRows(tasks, new Set()).map(row => row.task.id);
  assert.deepEqual(open, ['R1', 'A', 'A1', 'R2', 'B']);
  const collapsed = outlineRows(tasks, new Set(['A'])).map(row => row.task.id);
  assert.deepEqual(collapsed, ['R1', 'A', 'R2', 'B']);
  const depths = Object.fromEntries(outlineRows(tasks, new Set()).map(row => [row.task.id, row.depth]));
  assert.equal(depths.A1, 2);
});

test('tasks with missing parents stay visible instead of disappearing', () => {
  const tasks = [task({ id: 'A' }), task({ id: 'Orphan', parent: 'missing' })];
  const rows = outlineRows(tasks, new Set()).map(row => row.task.id);
  assert.ok(rows.includes('Orphan'));
});

test('plan shape stays a plain patch list for apply', () => {
  const tasks = [task({ id: 'A' }), task({ id: 'B' })];
  const operations = moveOperations(tasks, 'B', 'A', 'after');
  assert.ok(operations.every(operation => operation.op === 'patch'));
  assert.ok(operations.every(operation => 'expectedVersion' in operation === false));
  assert.deepEqual(operations.map(operation => (operation as { id: string }).id), ['A', 'B']);
  const moved = operations.find(operation => operation.op === 'patch' && operation.id === 'B') as { changes: { parent: string | null; order: string } };
  assert.equal(moved.changes.parent, null);
  assert.ok(moved.changes.order > 'a001');
});
