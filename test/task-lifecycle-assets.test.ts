import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { TaskAssets } from '../src/ui/task-assets.js';
import { TaskProperties } from '../src/ui/task-properties.js';
import type { TaskGraphPort } from '../src/ui/port.js';
import type { Plan, State, Task, TaskRecord } from '../src/types.js';

const task = (over: Partial<Task> = {}): Task => ({ schema: 1, id: 'task-a', title: 'A', status: 'canceled', parent: null, blocked_by: [], order: 'a0', repo: null, archived: false, body: '', assets: [], ...over });
const record = (value: Task, version = 'v1'): TaskRecord => ({ task: value, version, content: '' });
const state = (...tasks: Task[]): State => ({ schemaVersion: 1, revision: 'r1', tasks, diagnostics: [], ready: [] });
function port(overrides: Partial<TaskGraphPort> = {}): TaskGraphPort {
  return { getState: async () => state(task()), readTask: async () => record(task()), subscribe: () => () => {},
    apply: async plan => ({ schemaVersion: 1, requestId: plan.requestId, revision: 'r2', ids: {}, versions: {} }),
    readAsset: async () => ({ content: 'content', path: 'a.txt', version: 'file1' }), ...overrides };
}
function text(node: ReactTestInstance | string): string { return typeof node === 'string' ? node : node.children.map(text).join(''); }
function buttons(view: ReactTestRenderer, label: string) { return view.root.findAllByType('button').filter(node => text(node) === label); }
async function click(view: ReactTestRenderer, label: string, index = 0) { await act(async () => { buttons(view, label)[index]!.props.onClick(); }); }
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
} });
async function selectStatus(view: ReactTestRenderer, value: string) {
  await act(async () => view.root.findByProps({ 'aria-label': '任务状态' }).props.onChange({ target: { value } }));
}
async function submit(view: ReactTestRenderer) {
  await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
}
async function mount(t: { after(fn: () => void): void }, element: ReactElement) {
  storage.clear();
  let view!: ReactTestRenderer;
  await act(async () => { view = create(element); });
  t.after(() => act(() => view.unmount()));
  return view;
}
const assetTask = task({ assets: [{ kind: 'shared', share: 'task', path: 'a.txt' }, { kind: 'shared', share: 'task', path: 'b.txt' }] });

test('delete is selected in task properties and requires explicit confirmation before a conditional write', async t => {
  const plans: Plan[] = [];
  let refreshed = 0;
  const view = await mount(t, createElement(TaskProperties, { task: task(), record: record(task()), state: state(task()), onSelect: () => {},
    port: port({ apply: async plan => { plans.push(plan); return { schemaVersion: 1, requestId: plan.requestId, revision: 'r2', ids: {}, versions: {} }; } }), onChanged: async () => { refreshed++; } }));
  await selectStatus(view, 'delete');
  assert.equal(plans.length, 0);
  assert.equal(buttons(view, '确认永久删除').length, 1);
  await click(view, '取消所选操作');
  assert.equal(plans.length, 0);
  await selectStatus(view, 'delete');
  await submit(view);
  assert.deepEqual(plans[0]!.operations, [{ op: 'delete', id: 'task-a', expectedVersion: 'v1' }]);
  assert.equal(plans[0]!.baseRevision, 'r1');
  assert.equal(refreshed, 1);
});

test('status selector explains and disables deletion for state, dependency and child blockers', async t => {
  const a = task({ status: 'todo', blocked_by: ['dep'] });
  const view = await mount(t, createElement(TaskProperties, { task: a, record: record(a), state: state(a, task({ id: 'dep' }), task({ id: 'child', parent: a.id }), task({ id: 'dependent', title: '依赖方', blocked_by: [a.id], archived: true })), onSelect: () => {}, port: port(), onChanged: async () => {} }));
  assert.equal(view.root.findByProps({ value: 'delete' }).props.disabled, true);
  assert.match(text(view.root), /先取消或归档/);
  assert.match(text(view.root), /全部直接依赖/);
  assert.match(text(view.root), /依赖方/);
  assert.match(text(view.root), /全部子任务/);
});

test('a newly added dependent invalidates an already selected delete operation', async t => {
  const plans: Plan[] = [];
  const props = { task: task(), record: record(task()), onSelect: () => {}, port: port({ apply: async plan => { plans.push(plan); throw new Error('must not submit'); } }), onChanged: async () => {} };
  const view = await mount(t, createElement(TaskProperties, { ...props, state: state(task()) }));
  await selectStatus(view, 'delete');
  await act(async () => view.update(createElement(TaskProperties, { ...props, state: state(task(), task({ id: 'dependent', blocked_by: ['task-a'] })) })));
  assert.equal(buttons(view, '确认永久删除')[0]!.props.disabled, true);
  await submit(view);
  assert.equal(plans.length, 0);
});

test('drafts block destructive actions; cancellation and archive use separate status choices', async t => {
  const plans: Plan[] = [];
  const a = task({ status: 'todo' });
  const props = { task: a, record: record(a), state: state(a), onSelect: () => {}, onChanged: async () => {}, port: port({ apply: async plan => { plans.push(plan); return { schemaVersion: 1, requestId: plan.requestId, revision: 'r2', ids: {}, versions: { 'task-a': 'v2' } }; } }) };
  const view = await mount(t, createElement(TaskProperties, { ...props, bodyDirty: true }));
  assert.equal(view.root.findByProps({ value: 'delete' }).props.disabled, true);
  await selectStatus(view, 'canceled');
  assert.equal(plans.length, 0);
  await submit(view);
  assert.deepEqual(plans[0]!.operations, [{ op: 'patch', id: 'task-a', expectedVersion: 'v1', changes: { status: 'canceled' } }]);
  const done = task({ status: 'done' });
  await act(async () => view.update(createElement(TaskProperties, { ...props, task: done, record: record(done, 'v3'), state: state(done), bodyDirty: false })));
  assert.equal(view.root.findByProps({ value: 'delete' }).props.disabled, true);
  await selectStatus(view, 'archive');
  assert.equal(plans.length, 1);
  await submit(view);
  assert.deepEqual(plans[1]!.operations, [{ op: 'patch', id: 'task-a', changes: {}, expectedVersion: 'v3' }, { op: 'archive', id: 'task-a' }]);
});

test('failed deletion retains the chosen action and reports the error in task properties', async t => {
  const view = await mount(t, createElement(TaskProperties, { task: task(), record: record(task()), state: state(task()), onSelect: () => {},
    port: port({ apply: async () => { throw new Error('version conflict'); } }), onChanged: async () => {} }));
  await selectStatus(view, 'delete');
  await submit(view);
  assert.match(text(view.root), /version conflict/);
  assert.equal(buttons(view, '确认永久删除').length, 1);
});

test('restoring through the status selector preserves the archived task execution status', async t => {
  const plans: Plan[] = [];
  const a = task({ status: 'done', archived: true });
  const view = await mount(t, createElement(TaskProperties, { task: a, record: record(a), state: state(a), onSelect: () => {}, onChanged: async () => {},
    port: port({ apply: async plan => { plans.push(plan); return { schemaVersion: 1, requestId: plan.requestId, revision: 'r2', ids: {}, versions: {} }; } }) }));
  assert.equal(view.root.findByProps({ 'aria-label': '任务状态' }).props.value, 'archived');
  await selectStatus(view, 'restore');
  assert.equal(plans.length, 0);
  assert.equal(buttons(view, '确认取消归档').length, 1);
  await submit(view);
  assert.deepEqual(plans[0]!.operations, [{ op: 'patch', id: a.id, changes: {}, expectedVersion: 'v1' }, { op: 'restore', id: a.id }]);
});

test('asset contents load lazily, expand independently and collapse without unlinking', async t => {
  const reads: number[] = [];
  const p = port({ readAsset: async (_id, index) => { reads.push(index); return { content: `content-${index}`, path: index === 0 ? 'a.txt' : 'b.txt', version: 'file1' }; } });
  const view = await mount(t, createElement(TaskAssets, { record: record(assetTask), state: state(assetTask), port: p, onChanged: async () => {} }));
  assert.deepEqual(reads, []);
  const toggle = (name: string) => view.root.findAllByType('button').find(node => node.props['aria-label'] === name)!;
  await act(async () => { toggle('展开 shared:a.txt').props.onClick(); });
  await act(async () => { toggle('展开 shared:b.txt').props.onClick(); });
  assert.deepEqual(reads, [0, 1]);
  assert.equal(view.root.findAllByType('pre').length, 2);
  await act(async () => { toggle('收起 shared:a.txt').props.onClick(); });
  assert.equal(view.root.findAllByType('pre').length, 1);
  assert.equal(text(view.root.findByType('pre')), 'content-1');
  assert.equal(buttons(view, '解除关联').length, 2);
});

test('collapsing an asset aborts its pending read and ignores late content', async t => {
  let resolve!: (value: { content: string; path: string; version: string }) => void;
  let signal: AbortSignal | undefined;
  const pending = new Promise<{ content: string; path: string; version: string }>(accept => { resolve = accept; });
  const view = await mount(t, createElement(TaskAssets, { record: record(assetTask), state: state(assetTask), port: port({ readAsset: async (_id, _index, currentSignal) => { signal = currentSignal; return pending; } }), onChanged: async () => {} }));
  await act(async () => view.root.findAllByType('button').find(node => node.props['aria-label'] === '展开 shared:a.txt')!.props.onClick());
  await act(async () => view.root.findAllByType('button').find(node => node.props['aria-label'] === '收起 shared:a.txt')!.props.onClick());
  assert.equal(signal?.aborted, true);
  await act(async () => resolve({ content: 'late', path: 'a.txt', version: 'v' }));
  assert.equal(view.root.findAllByType('pre').length, 0);
});

test('unlink patches only assets with both revisions and requires confirmation', async t => {
  const plans: Plan[] = [];
  const view = await mount(t, createElement(TaskAssets, { record: record(assetTask), state: state(assetTask), onChanged: async () => {},
    port: port({ apply: async plan => { plans.push(plan); return { schemaVersion: 1, requestId: plan.requestId, revision: 'r2', ids: {}, versions: {} }; } }) }));
  await click(view, '解除关联', 0);
  assert.equal(plans.length, 0);
  await click(view, '确认解除');
  assert.equal(plans[0]!.baseRevision, 'r1');
  assert.deepEqual(plans[0]!.operations, [{ op: 'patch', id: 'task-a', expectedVersion: 'v1', changes: { assets: [assetTask.assets[1]] } }]);
});

test('unlink conflict keeps the reference and permits retry; asset index changes reset old contents', async t => {
  const p = port({ apply: async () => { throw new Error('version conflict'); } });
  const view = await mount(t, createElement(TaskAssets, { record: record(assetTask), state: state(assetTask), port: p, onChanged: async () => {} }));
  await act(async () => view.root.findAllByType('button').find(node => node.props['aria-label'] === '展开 shared:a.txt')!.props.onClick());
  await click(view, '解除关联');
  await click(view, '确认解除');
  assert.match(text(view.root), /version conflict/);
  assert.equal(buttons(view, '解除关联').length, 2);
  assert.equal(buttons(view, '确认解除')[0]!.props.disabled, false);
  const updated = { ...assetTask, assets: [assetTask.assets[1]!] };
  await act(async () => view.update(createElement(TaskAssets, { record: record(updated, 'v2'), state: state(updated), port: p, onChanged: async () => {} })));
  assert.equal(view.root.findAllByType('pre').length, 0);
  assert.equal(buttons(view, '解除关联').length, 1);
});
