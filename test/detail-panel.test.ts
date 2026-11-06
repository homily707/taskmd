import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

register('./css-loader.mjs', import.meta.url);
const { TaskmdDetailPanel } = await import('../src/ui/taskmd-app.js');
import type { TaskGraphPort } from '../src/ui/port.js';
import type { ApplyResult, Plan, State, Task, TaskRecord } from '../src/types.js';

const task = (over: Partial<Task> = {}): Task => ({
  schema: 1, id: 'task-a', title: '任务 A', status: 'todo', parent: null, blocked_by: [],
  order: 'a0', repo: 'repo-a', assets: [], archived: false, body: '# 原正文\n', ...over,
});
const record = (value: Task, version = 'v1'): TaskRecord =>
  ({ task: value, version, content: `---\nid: ${value.id}\n---\n${value.body}` });
const state = (value: Task | Task[], revision = 'r1'): State =>
  ({ schemaVersion: 1, revision, tasks: Array.isArray(value) ? value : [value], diagnostics: [], ready: [] });

function portWith(initial: Task) {
  let current = { task: initial, version: 'v1' };
  let revision = 'r1';
  let version = 1;
  let revisionNumber = 1;
  let failNext: Error | undefined;
  const plans: Plan[] = [];
  const port: TaskGraphPort = {
    getState: async () => state(current.task, revision),
    readTask: async () => record(current.task, current.version),
    apply: async (plan: Plan): Promise<ApplyResult> => {
      plans.push(plan);
      if (failNext) { const error = failNext; failNext = undefined; throw error; }
      const change = plan.operations[0];
      if (change?.op === 'patch') {
        current = { task: { ...current.task, ...change.changes } as Task, version: `v${++version}` };
        revision = `r${++revisionNumber}`;
      }
      return { schemaVersion: 1, requestId: plan.requestId, revision, ids: {}, versions: { [current.task.id]: current.version } };
    },
    readAsset: async () => { throw new Error('unused'); },
    subscribe: () => () => {},
  };
  return { port, plans, failNext(error: Error) { failNext = error; } };
}

async function mount(t: { after(fn: () => void): void }, element: React.ReactElement) {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(element); });
  t.after(() => { act(() => view.unmount()); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return view;
}
function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}
function hasButton(view: ReactTestRenderer, label: string): boolean {
  return view.root.findAllByType('button').some(node => text(node) === label);
}
async function click(view: ReactTestRenderer, label: string) {
  const found = view.root.findAllByType('button').find(node => text(node) === label);
  assert.ok(found, `missing button: ${label}`);
  await act(async () => { found.props.onClick(); await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function submit(view: ReactTestRenderer) {
  const form = view.root.findAllByType('form')[0];
  assert.ok(form, 'missing form');
  await act(async () => { form.props.onSubmit({ preventDefault() {} }); await new Promise(resolve => setTimeout(resolve, 0)); });
}
function field(view: ReactTestRenderer, label: string) {
  const found = view.root.findAll(node => node.props['aria-label'] === label);
  assert.ok(found.length, `missing field: ${label}`);
  return found[0]!;
}

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { addEventListener() {}, removeEventListener() {}, confirm: () => true },
});

test('compact panel starts and completes a task from the header', async t => {
  const target = task({ status: 'todo' });
  const { port, plans } = portWith(target);
  const view = await mount(t, createElement(TaskmdDetailPanel, { port, taskId: target.id }));
  assert.ok(hasButton(view, '开始任务'), 'todo tasks expose the start action');
  assert.equal(view.root.findAll(node => node.props['aria-label'] === '任务状态').length, 1, 'one status control');

  await click(view, '开始任务');
  assert.deepEqual(plans[0]?.operations, [{ op: 'patch', id: 'task-a', expectedVersion: 'v1', changes: { status: 'in_progress' } }]);
  assert.ok(hasButton(view, '完成任务'), 'in-progress tasks expose the complete action');

  await click(view, '完成任务');
  assert.deepEqual(plans[1]?.operations, [{ op: 'patch', id: 'task-a', expectedVersion: 'v2', changes: { status: 'done' } }]);
  assert.ok(hasButton(view, '重新打开'), 'done tasks expose the reopen action');
});

test('a body draft survives a header status change and rebases its save version', async t => {
  const target = task({ status: 'todo' });
  const { port, plans } = portWith(target);
  const view = await mount(t, createElement(TaskmdDetailPanel, { port, taskId: target.id }));
  const editor = view.root.findByType('textarea');
  await act(async () => { editor.props.onChange({ target: { value: '# 本地草稿\n' } }); });

  await click(view, '开始任务');
  assert.equal(view.root.findByType('textarea').props.value, '# 本地草稿\n', 'the body draft is untouched by the status write');

  await click(view, '保存正文');
  assert.deepEqual(plans[1]?.operations, [{ op: 'patch', id: 'task-a', expectedVersion: 'v2', changes: { body: '# 本地草稿\n' } }]);
});

test('a property draft survives a header status change and does not resend status', async t => {
  const target = task({ status: 'todo' });
  const { port, plans } = portWith(target);
  const view = await mount(t, createElement(TaskmdDetailPanel, { port, taskId: target.id }));
  await act(async () => { field(view, '任务标题').props.onChange({ target: { value: '任务 A2' } }); });

  await click(view, '开始任务');
  assert.equal(field(view, '任务标题').props.value, '任务 A2', 'the property draft is untouched by the status write');

  await submit(view);
  assert.deepEqual(plans[1]?.operations, [{ op: 'patch', id: 'task-a', expectedVersion: 'v2', changes: { title: '任务 A2' } }]);
});

test('a failed status request keeps the old status and reports the error', async t => {
  const target = task({ status: 'todo' });
  const { port, plans, failNext } = portWith(target);
  const view = await mount(t, createElement(TaskmdDetailPanel, { port, taskId: target.id }));
  failNext(Object.assign(new Error('network unavailable'), { code: 'network_error' }));

  await click(view, '开始任务');
  assert.equal(plans.length, 1);
  assert.ok(hasButton(view, '开始任务'), 'the task stays actionable in its old status');
  const alert = view.root.findAll(node => node.props.role === 'alert').map(text).join('\n');
  assert.match(alert, /network unavailable/);
});

test('a double click on the status action sends one mutation', async t => {
  const target = task({ status: 'todo' });
  const { port, plans } = portWith(target);
  const view = await mount(t, createElement(TaskmdDetailPanel, { port, taskId: target.id }));
  const action = view.root.findAllByType('button').find(node => text(node) === '开始任务');
  assert.ok(action);
  await act(async () => {
    action.props.onClick();
    action.props.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(plans.length, 1);
});

test('the status select and primary button share one pending guard', async t => {
  const target = task({ status: 'todo' });
  const { port, plans } = portWith(target);
  const view = await mount(t, createElement(TaskmdDetailPanel, { port, taskId: target.id }));
  const select = view.root.findAll(node => node.props['aria-label'] === '任务状态')[0];
  const action = view.root.findAllByType('button').find(node => text(node) === '开始任务');
  assert.ok(select && action);
  await act(async () => {
    select.props.onChange({ target: { value: 'in_progress' }, currentTarget: { value: 'todo' } });
    action.props.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0]?.operations, [{ op: 'patch', id: 'task-a', expectedVersion: 'v1', changes: { status: 'in_progress' } }]);
});

test('a parent task exposes completion only after all children are terminal', async t => {
  const parent = task({ id: 'task-p', status: 'todo' });
  const child = task({ id: 'task-c', parent: 'task-p', status: 'todo' });
  const port: TaskGraphPort = {
    getState: async () => state([parent, child]),
    readTask: async id => record([parent, child].find(item => item.id === id)!),
    apply: async () => { throw new Error('unused'); },
    readAsset: async () => { throw new Error('unused'); },
    subscribe: () => () => {},
  };
  const view = await mount(t, createElement(TaskmdDetailPanel, { port, taskId: parent.id }));
  const select = view.root.findAll(node => node.props['aria-label'] === '任务状态')[0]!;
  const options = select.findAllByType('option');
  assert.equal(options.find(option => option.props.value === 'in_progress')!.props.disabled, true);
  assert.equal(options.find(option => option.props.value === 'done')!.props.disabled, true);
  assert.equal(hasButton(view, '开始任务'), false);
  assert.equal(hasButton(view, '确认完成'), false);
  assert.equal(hasButton(view, '完成任务'), false);
});

test('a parent task can complete once every child is terminal', async t => {
  const parent = task({ id: 'task-p', status: 'in_progress' });
  const child = task({ id: 'task-c', parent: 'task-p', status: 'done' });
  const port: TaskGraphPort = {
    getState: async () => state([parent, child]),
    readTask: async id => record([parent, child].find(item => item.id === id)!),
    apply: async () => { throw new Error('unused'); },
    readAsset: async () => { throw new Error('unused'); },
    subscribe: () => () => {},
  };
  const view = await mount(t, createElement(TaskmdDetailPanel, { port, taskId: parent.id }));
  const select = view.root.findAll(node => node.props['aria-label'] === '任务状态')[0]!;
  assert.equal(select.findAllByType('option').find(option => option.props.value === 'done')!.props.disabled, false);
  assert.ok(hasButton(view, '确认完成'));
});

test('a blocked leaf explains its blocker and disables start and complete', async t => {
  const dependency = task({ id: 'task-dep', title: '前置任务', status: 'todo' });
  const blocked = task({ id: 'task-b', title: '阻塞任务', status: 'todo', blocked_by: ['task-dep'] });
  const port: TaskGraphPort = {
    getState: async () => state([dependency, blocked]),
    readTask: async id => record([dependency, blocked].find(item => item.id === id)!),
    apply: async () => { throw new Error('unused'); },
    readAsset: async () => { throw new Error('unused'); },
    subscribe: () => () => {},
  };
  const view = await mount(t, createElement(TaskmdDetailPanel, { port, taskId: blocked.id }));
  const select = view.root.findAll(node => node.props['aria-label'] === '任务状态')[0]!;
  const options = select.findAllByType('option');
  assert.equal(options.find(option => option.props.value === 'in_progress')!.props.disabled, true);
  assert.equal(options.find(option => option.props.value === 'done')!.props.disabled, true);
  const textContent = view.root.findAll(node => node.props.role === 'status').map(text).join('\n');
  assert.match(textContent, /前置任务/);
});
