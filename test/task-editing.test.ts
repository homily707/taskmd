import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { TaskEditor } from '../src/ui/task-editor.js';
import { TaskProperties } from '../src/ui/task-properties.js';
import { bodyDiff, isVersionConflict, loadDraft, storeDraft, taskFailure } from '../src/ui/task-editing.js';
import type { TaskGraphPort } from '../src/ui/port.js';
import { Store } from '../src/core/store.js';
import type { ApplyResult, Plan, State, Task, TaskRecord } from '../src/types.js';
import { withSandbox } from './helpers.js';

/**
 * The editor and the properties panel persist drafts through `sessionStorage`.
 * Node has none, so every test runs against one in-memory map that survives
 * unmounts — exactly what a page reload within a session does.
 */
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => { storage.clear(); },
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() { return storage.size; },
  },
});

const bodyKey = 'taskmd:body-draft:task-a';
const propertiesKey = 'taskmd:properties-draft:task-a';

const makeTask = (over: Partial<Task> = {}): Task => ({
  schema: 1, id: 'task-a', title: '任务 A', status: 'todo', parent: null, blocked_by: [],
  order: 'a0', repo: null, assets: [], archived: false, body: '# 原正文\n', ...over,
});
const makeRecord = (task: Task, version = 'v1'): TaskRecord =>
  ({ task, version, content: `---\nschema: 1\nid: ${task.id}\n---\n${task.body}` });
const makeState = (tasks: Task[], revision = 'r1'): State =>
  ({ schemaVersion: 1, revision, tasks, diagnostics: [], ready: [] });
const applied = (id: string, version: string, revision: string): ApplyResult =>
  ({ schemaVersion: 1, requestId: 'req', revision, ids: {}, versions: { [id]: version } });

function portWith(handlers: {
  record(): TaskRecord;
  state(): State;
  apply(plan: Plan): Promise<ApplyResult>;
}) {
  const plans: Plan[] = [];
  const port: TaskGraphPort = {
    getState: async () => handlers.state(),
    readTask: async () => handlers.record(),
    apply: async plan => { plans.push(plan); return handlers.apply(plan); },
    readAsset: async () => { throw new Error('unused'); },
    subscribe: () => () => {},
  };
  return { port, plans };
}

type Context = { after(fn: () => void): void };

async function mount(t: Context, element: ReactElement) {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(element); });
  t.after(() => { act(() => view.unmount()); });
  return view;
}

/** react-test-renderer does not run the event system, so handlers are invoked directly. */
async function click(view: ReactTestRenderer, label: string) {
  const node = button(view, label);
  await act(async () => {
    node.props.onClick();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
async function submit(view: ReactTestRenderer) {
  await act(async () => {
    view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}
async function rerender(view: ReactTestRenderer, element: ReactElement) {
  await act(async () => { view.update(element); });
}

function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}
function button(view: ReactTestRenderer, label: string) {
  const found = view.root.findAllByType('button').find(node => text(node) === label);
  assert.ok(found, `missing button: ${label}`);
  return found;
}
function hasButton(view: ReactTestRenderer, label: string) {
  return view.root.findAllByType('button').some(node => text(node) === label);
}
function labelled(view: ReactTestRenderer, label: string) {
  return view.root.findAll(node => node.props['aria-label'] === label);
}
function field(view: ReactTestRenderer, label: string) {
  const found = view.root.findAll(node => node.props['aria-label'] === label);
  assert.ok(found.length, `missing field: ${label}`);
  return found[0]!;
}
function textarea(view: ReactTestRenderer) {
  return view.root.findByType('textarea');
}
/** The dependency rows are the only labels that hold a checkbox. */
function dependencyRows(view: ReactTestRenderer) {
  return view.root.findAllByType('label').filter(node => node.findAllByType('input').some(input => input.props.type === 'checkbox'));
}
function checkbox(view: ReactTestRenderer, title: string) {
  const row = dependencyRows(view).find(node => text(node).includes(title));
  assert.ok(row, `missing dependency candidate: ${title}`);
  return row.findByType('input');
}
function dependencyTitles(view: ReactTestRenderer) {
  return dependencyRows(view).map(row => text(row).replace(/（现有关系已失效.*$/, ''));
}
async function type(view: ReactTestRenderer, value: string) {
  await act(async () => { textarea(view).props.onChange({ target: { value } }); });
}

test.beforeEach(() => { storage.clear(); });

test('saving the body sends a body-only patch with the expected version', async t => {
  const task = makeTask();
  const { port, plans } = portWith({
    record: () => makeRecord(task),
    state: () => makeState([task]),
    apply: async () => applied(task.id, 'v2', 'r2'),
  });
  let changed = 0;
  const dirty: boolean[] = [];
  const view = await mount(t, createElement(TaskEditor, {
    record: makeRecord(task), port, state: makeState([task]),
    onChanged: async () => { changed += 1; }, onDirty: value => dirty.push(value),
  }));

  await type(view, '# 新正文\n');
  assert.deepEqual(dirty.at(-1), true);
  assert.ok(loadDraft(bodyKey), 'a draft is persisted while typing');
  assert.equal(button(view, '保存正文').props.disabled, false);

  await click(view, '保存正文');

  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.baseRevision, 'r1');
  assert.deepEqual(plans[0]!.operations, [
    { op: 'patch', id: 'task-a', expectedVersion: 'v1', changes: { body: '# 新正文\n' } },
  ]);
  assert.equal(changed, 1);
  assert.equal(loadDraft(bodyKey), undefined, 'a successful save clears the draft');
  assert.deepEqual(dirty.at(-1), false);
  assert.equal(textarea(view).props.value, '# 新正文\n');
  assert.ok(labelled(view, '正文编辑').length > 0);
});

test('editing back to the saved text clears the draft instead of keeping a no-op change', async t => {
  const task = makeTask();
  const { port } = portWith({
    record: () => makeRecord(task), state: () => makeState([task]),
    apply: async () => applied(task.id, 'v2', 'r2'),
  });
  const view = await mount(t, createElement(TaskEditor, {
    record: makeRecord(task), port, state: makeState([task]), onChanged: async () => {}, onDirty: () => {},
  }));

  await type(view, '# 改一下\n');
  assert.ok(loadDraft(bodyKey));
  await type(view, '# 原正文\n');
  assert.equal(loadDraft(bodyKey), undefined);
  assert.equal(button(view, '保存正文').props.disabled, true);
});

test('a version conflict keeps the draft, shows the diff, and retries against the latest version', async t => {
  const task = makeTask();
  const latestTask = makeTask({ title: '任务 A（别处改过）', body: '# 磁盘上的新正文\n' });
  let record = makeRecord(task);
  let state = makeState([task]);
  let fail = true;
  const { port, plans } = portWith({
    record: () => record,
    state: () => state,
    apply: async () => {
      if (fail) throw Object.assign(new Error('Task task-a has changed.'), { code: 'version_conflict', hint: 'Read the current state, merge your changes, and retry with its version.' });
      return applied(task.id, 'v3', 'r3');
    },
  });
  const view = await mount(t, createElement(TaskEditor, {
    record, port, state, onChanged: async () => {}, onDirty: () => {},
  }));

  await type(view, '# 本地草稿\n');
  record = makeRecord(latestTask, 'v2'); state = makeState([latestTask], 'r2');
  await click(view, '保存正文');

  assert.equal(labelled(view, '正文冲突恢复').length, 1, 'conflict recovery is visible');
  const diff = text(labelled(view, '最新正文与本地草稿差异')[0]!);
  assert.match(diff, /- # 磁盘上的新正文/);
  assert.match(diff, /\+ # 本地草稿/);
  assert.equal(textarea(view).props.value, '# 本地草稿\n', 'the local draft stays editable');
  assert.ok(loadDraft(bodyKey), 'the draft survives the conflict');
  assert.equal(button(view, '保存正文').props.disabled, true, 'plain save is blocked until merged');
  assert.equal(button(view, '已人工合并，使用最新版本重试').props.disabled, false);

  fail = false;
  await click(view, '已人工合并，使用最新版本重试');

  assert.equal(plans.at(-1)!.baseRevision, 'r2');
  assert.deepEqual(plans.at(-1)!.operations, [
    { op: 'patch', id: 'task-a', expectedVersion: 'v2', changes: { body: '# 本地草稿\n' } },
  ]);
  assert.equal(labelled(view, '正文冲突恢复').length, 0);
  assert.equal(loadDraft(bodyKey), undefined);
});

test('a concurrent change that left the body alone rebases the draft without a conflict', async t => {
  const task = makeTask();
  const moved = makeTask({ title: '任务 A（改名）' });
  const { port, plans } = portWith({
    record: () => makeRecord(moved, 'v2'), state: () => makeState([moved], 'r2'),
    apply: async () => applied(task.id, 'v3', 'r3'),
  });
  const view = await mount(t, createElement(TaskEditor, {
    record: makeRecord(task), port, state: makeState([task]), onChanged: async () => {}, onDirty: () => {},
  }));

  await type(view, '# 本地草稿\n');
  await rerender(view, createElement(TaskEditor, {
    record: makeRecord(moved, 'v2'), port, state: makeState([moved], 'r2'), onChanged: async () => {}, onDirty: () => {},
  }));

  assert.equal(labelled(view, '正文冲突恢复').length, 0, 'a body-identical change is not a conflict');
  assert.equal(button(view, '保存正文').props.disabled, false);
  await click(view, '保存正文');
  assert.equal(plans.at(-1)!.baseRevision, 'r2');
  assert.equal((plans.at(-1)!.operations[0] as { expectedVersion: string }).expectedVersion, 'v2');
});

test('an external body change with a draft in progress becomes an explicit conflict', async t => {
  const task = makeTask();
  const changed = makeTask({ body: '# 别人写的正文\n' });
  const { port } = portWith({
    record: () => makeRecord(changed, 'v2'), state: () => makeState([changed], 'r2'),
    apply: async () => applied(task.id, 'v3', 'r3'),
  });
  const view = await mount(t, createElement(TaskEditor, {
    record: makeRecord(task), port, state: makeState([task]), onChanged: async () => {}, onDirty: () => {},
  }));

  await type(view, '# 我的草稿\n');
  await rerender(view, createElement(TaskEditor, {
    record: makeRecord(changed, 'v2'), port, state: makeState([changed], 'r2'), onChanged: async () => {}, onDirty: () => {},
  }));

  assert.equal(labelled(view, '正文冲突恢复').length, 1);
  assert.match(text(labelled(view, '最新正文与本地草稿差异')[0]!), /- # 别人写的正文/);
  assert.equal(textarea(view).props.value, '# 我的草稿\n');
  assert.equal(button(view, '保存正文').props.disabled, true);
});

test('switching tasks keeps the draft for the task left behind', async t => {
  const a = makeTask();
  const b = makeTask({ id: 'task-b', title: '任务 B', body: '# B 正文\n' });
  const { port } = portWith({
    record: () => makeRecord(a), state: () => makeState([a, b]),
    apply: async () => applied(a.id, 'v2', 'r2'),
  });
  const dirty: boolean[] = [];
  const props = { port, state: makeState([a, b]), onChanged: async () => {}, onDirty: (value: boolean) => dirty.push(value) };
  let view = await mount(t, createElement(TaskEditor, { ...props, record: makeRecord(a) }));
  await type(view, '# A 的草稿\n');

  // The host switches tasks by remounting with another record.
  await rerender(view, createElement(TaskEditor, { ...props, record: makeRecord(b) }));
  assert.equal(textarea(view).props.value, '# B 正文\n');
  assert.equal(loadDraft('taskmd:body-draft:task-b'), undefined);
  assert.deepEqual(dirty.at(-1), false, 'the host is told the visible task is clean');
  assert.ok(loadDraft(bodyKey), 'the old draft is not silently discarded');

  await rerender(view, createElement(TaskEditor, { ...props, record: makeRecord(a) }));
  assert.equal(textarea(view).props.value, '# A 的草稿\n');
  assert.deepEqual(dirty.at(-1), true);
});

test('loading the latest body asks before dropping a draft and honours the refusal', async t => {
  const task = makeTask();
  const changed = makeTask({ body: '# 磁盘正文\n' });
  const { port } = portWith({
    record: () => makeRecord(changed, 'v2'), state: () => makeState([changed], 'r2'),
    apply: async () => applied(task.id, 'v3', 'r3'),
  });
  const view = await mount(t, createElement(TaskEditor, {
    record: makeRecord(task), port, state: makeState([task]), onChanged: async () => {}, onDirty: () => {},
  }));
  await type(view, '# 本地草稿\n');

  const prompts: string[] = [];
  const refused = Object.assign(globalThis, { window: { confirm: (message: string) => { prompts.push(message); return false; } } });
  try {
    await click(view, '加载最新正文');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /丢弃本地正文草稿/);
    assert.ok(loadDraft(bodyKey), 'refusing the prompt keeps the draft');
    assert.equal(textarea(view).props.value, '# 本地草稿\n');
  } finally { delete (refused as { window?: unknown }).window; }

  // Without a dialog the explicit action proceeds.
  await click(view, '加载最新正文');
  assert.equal(loadDraft(bodyKey), undefined);
  assert.equal(textarea(view).props.value, '# 磁盘正文\n');
});

test('discarding a draft is explicit and reports a clean state', async t => {
  const task = makeTask();
  const { port } = portWith({
    record: () => makeRecord(task), state: () => makeState([task]),
    apply: async () => applied(task.id, 'v2', 'r2'),
  });
  const dirty: boolean[] = [];
  const view = await mount(t, createElement(TaskEditor, {
    record: makeRecord(task), port, state: makeState([task]), onChanged: async () => {}, onDirty: value => dirty.push(value),
  }));
  await type(view, '# 草稿\n');
  await click(view, '放弃草稿');
  assert.equal(loadDraft(bodyKey), undefined);
  assert.equal(textarea(view).props.value, '# 原正文\n');
  assert.deepEqual(dirty.at(-1), false);
});

test('a save failure keeps the draft and shows the reason', async t => {
  const task = makeTask();
  const { port } = portWith({
    record: () => makeRecord(task), state: () => makeState([task]),
    apply: async () => { throw Object.assign(new Error('The final task graph is invalid.'), { code: 'validation_failed', hint: 'Fix all reported errors and retry.', details: [{ message: 'Dependency task-x must share the same direct parent.' }] }); },
  });
  const view = await mount(t, createElement(TaskEditor, {
    record: makeRecord(task), port, state: makeState([task]), onChanged: async () => {}, onDirty: () => {},
  }));
  await type(view, '# 草稿\n');
  await click(view, '保存正文');
  const alert = view.root.findAllByType('pre').find(node => node.props.role === 'alert')!;
  assert.match(text(alert), /validation_failed/);
  assert.match(text(alert), /Dependency task-x must share the same direct parent/);
  assert.ok(loadDraft(bodyKey));
  assert.equal(textarea(view).props.value, '# 草稿\n');
});

test('text typed while the save is in flight becomes a new draft instead of being lost', async t => {
  const task = makeTask();
  let release!: (result: ApplyResult) => void;
  const pending = new Promise<ApplyResult>(resolve => { release = resolve; });
  const { port } = portWith({
    record: () => makeRecord(task), state: () => makeState([task]), apply: () => pending,
  });
  const view = await mount(t, createElement(TaskEditor, {
    record: makeRecord(task), port, state: makeState([task]), onChanged: async () => {}, onDirty: () => {},
  }));
  await type(view, '# 第一次输入\n');
  await act(async () => { button(view, '保存正文').props.onClick(); });
  // The submitted text is captured up front, so typing during the request is a
  // new draft rather than a lost keystroke or a corrupted write.
  await act(async () => { textarea(view).props.onChange({ target: { value: '# 第二次输入\n' } }); });
  await act(async () => { release(applied(task.id, 'v2', 'r2')); await new Promise(resolve => setTimeout(resolve, 0)); });

  assert.equal(textarea(view).props.value, '# 第二次输入\n');
  const draft = loadDraft(bodyKey) as { body: string; version: string; baseBody: string };
  assert.equal(draft.body, '# 第二次输入\n');
  assert.equal(draft.version, 'v2', 'the draft now sits on top of the version just written');
  assert.equal(draft.baseBody, '# 第一次输入\n');
  assert.equal(button(view, '保存正文').props.disabled, false);
});

test('property edits save only the changed fields and never the body', async t => {
  const task = makeTask();
  const { port, plans } = portWith({
    record: () => makeRecord(task), state: () => makeState([task]),
    apply: async () => applied(task.id, 'v2', 'r2'),
  });
  let changed = 0;
  const dirty: boolean[] = [];
  const view = await mount(t, createElement(TaskProperties, {
    task, record: makeRecord(task), port, state: makeState([task]),
    onChanged: async () => { changed += 1; }, onSelect: () => {}, onDirty: value => dirty.push(value),
  }));

  await act(async () => { field(view, '任务标题').props.onChange({ target: { value: '任务 A2' } }); });
  assert.deepEqual(dirty.at(-1), true);
  await submit(view);

  assert.deepEqual(plans[0]!.operations, [
    { op: 'patch', id: 'task-a', expectedVersion: 'v1', changes: { title: '任务 A2' } },
  ]);
  assert.equal(plans[0]!.baseRevision, 'r1');
  assert.equal(changed, 1);
  assert.equal(loadDraft(propertiesKey), undefined);
  assert.deepEqual(dirty.at(-1), false);
});

test('saving properties leaves an unsaved body draft untouched', async t => {
  const task = makeTask();
  const { port } = portWith({
    record: () => makeRecord(task), state: () => makeState([task]),
    apply: async () => applied(task.id, 'v2', 'r2'),
  });
  const shared = { port, state: makeState([task]), onChanged: async () => {} };
  const editor = await mount(t, createElement(TaskEditor, { ...shared, record: makeRecord(task), onDirty: () => {} }));
  await type(editor, '# 正文草稿\n');
  assert.ok(loadDraft(bodyKey));

  const properties = await mount(t, createElement(TaskProperties, {
    ...shared, task, record: makeRecord(task), onSelect: () => {}, onDirty: () => {},
  }));
  await act(async () => { field(properties, '仓库名称').props.onChange({ target: { value: 'harless' } }); });
  await submit(properties);

  assert.ok(loadDraft(bodyKey), 'the body draft is still there');
  assert.equal(textarea(editor).props.value, '# 正文草稿\n');
  assert.equal(button(editor, '保存正文').props.disabled, false);
});

test('dependency candidates are limited to siblings under the same direct parent', async t => {
  const parent = makeTask({ id: 'task-p', title: '父任务', order: 'a0' });
  const sibling = makeTask({ id: 'task-b', title: '兄弟 B', parent: parent.id, order: 'a1' });
  const other = makeTask({ id: 'task-c', title: '表亲 C', parent: 'task-other', order: 'a2' });
  const task = makeTask({ parent: parent.id, order: 'a3' });
  const tasks = [parent, sibling, other, task];
  const { port, plans } = portWith({
    record: () => makeRecord(task), state: () => makeState(tasks),
    apply: async () => applied(task.id, 'v2', 'r2'),
  });
  const view = await mount(t, createElement(TaskProperties, {
    task, record: makeRecord(task), port, state: makeState(tasks), onChanged: async () => {}, onSelect: () => {},
  }));

  assert.deepEqual(dependencyTitles(view), [], 'unselected siblings are not displayed as dependencies');
  assert.deepEqual(field(view, '添加依赖').findAllByType('option').slice(1).map(text), ['兄弟 B']);
  await act(async () => { field(view, '添加依赖').props.onChange({ target: { value: sibling.id } }); });
  assert.deepEqual(dependencyTitles(view), ['兄弟 B']);
  assert.equal(field(view, '添加依赖').findAllByType('option').length, 1, 'selected dependencies are excluded from the picker');
  await submit(view);
  assert.deepEqual((plans[0]!.operations[0] as { changes: { blocked_by: string[] } }).changes, { blocked_by: ['task-b'] });
});

test('changing the parent re-scopes the dependency candidates', async t => {
  const parent = makeTask({ id: 'task-p', title: '父任务' });
  const sibling = makeTask({ id: 'task-b', title: '兄弟 B', parent: parent.id });
  const rootSibling = makeTask({ id: 'task-r', title: '根兄弟 R' });
  const task = makeTask({ parent: parent.id });
  const tasks = [parent, sibling, rootSibling, task];
  const { port } = portWith({
    record: () => makeRecord(task), state: () => makeState(tasks),
    apply: async () => applied(task.id, 'v2', 'r2'),
  });
  const view = await mount(t, createElement(TaskProperties, {
    task, record: makeRecord(task), port, state: makeState(tasks), onChanged: async () => {}, onSelect: () => {},
  }));

  assert.deepEqual(field(view, '添加依赖').findAllByType('option').slice(1).map(text), ['兄弟 B']);
  await act(async () => { field(view, '父任务').props.onChange({ target: { value: '' } }); });
  // Moving to the root re-scopes the list to the root's other tasks.
  assert.deepEqual(field(view, '添加依赖').findAllByType('option').slice(1).map(text), ['父任务', '根兄弟 R']);
});

test('an invalid existing dependency stays visible and removable', async t => {
  const parent = makeTask({ id: 'task-p', title: '父任务' });
  const other = makeTask({ id: 'task-c', title: '表亲 C', parent: 'task-other' });
  const task = makeTask({ parent: parent.id, blocked_by: ['task-c'] });
  const tasks = [parent, other, task];
  const { port, plans } = portWith({
    record: () => makeRecord(task), state: () => makeState(tasks),
    apply: async () => applied(task.id, 'v2', 'r2'),
  });
  const view = await mount(t, createElement(TaskProperties, {
    task, record: makeRecord(task), port, state: makeState(tasks), onChanged: async () => {}, onSelect: () => {},
  }));

  const row = dependencyRows(view).find(node => text(node).includes('表亲 C'))!;
  assert.match(text(row), /现有关系已失效/);
  assert.equal(row.findByType('input').props.checked, true);
  await act(async () => { row.findByType('input').props.onChange({ target: { checked: false } }); });
  await submit(view);
  assert.deepEqual((plans[0]!.operations[0] as { changes: { blocked_by: string[] } }).changes, { blocked_by: [] });
});

test('status offers the four states and labels explicit completion and reopening', async t => {
  const open = makeTask();
  const tasks = [open];
  const { port } = portWith({
    record: () => makeRecord(open), state: () => makeState(tasks), apply: async () => applied(open.id, 'v2', 'r2'),
  });
  const view = await mount(t, createElement(TaskProperties, {
    task: open, record: makeRecord(open), port, state: makeState(tasks), onChanged: async () => {}, onSelect: () => {},
  }));
  assert.deepEqual(field(view, '任务状态').findAllByType('option').map(option => option.props.value),
    ['todo', 'in_progress', 'done', 'canceled', 'archive', 'delete']);

  await act(async () => { field(view, '任务状态').props.onChange({ target: { value: 'done' } }); });
  assert.ok(hasButton(view, '明确完成并保存属性'));

  const done = makeTask({ status: 'done' });
  await rerender(view, createElement(TaskProperties, {
    task: done, record: makeRecord(done, 'v2'), port, state: makeState([done], 'r2'), onChanged: async () => {}, onSelect: () => {},
  }));
  await act(async () => { field(view, '任务状态').props.onChange({ target: { value: 'in_progress' } }); });
  assert.ok(hasButton(view, '明确重新打开并保存属性'));
});

test('a property conflict keeps the edit and retries only the changed fields', async t => {
  const task = makeTask();
  const latest = makeTask({ title: '别处改过的标题' });
  let record = makeRecord(task);
  let state = makeState([task]);
  let fail = true;
  const { port, plans } = portWith({
    record: () => record, state: () => state,
    apply: async () => {
      if (fail) throw Object.assign(new Error('Task task-a has changed.'), { code: 'version_conflict' });
      return applied(task.id, 'v3', 'r3');
    },
  });
  const view = await mount(t, createElement(TaskProperties, {
    task, record, port, state, onChanged: async () => {}, onSelect: () => {},
  }));

  await act(async () => { field(view, '任务状态').props.onChange({ target: { value: 'canceled' } }); });
  record = makeRecord(latest, 'v2'); state = makeState([latest], 'r2');
  await submit(view);

  assert.equal(labelled(view, '属性冲突恢复').length, 1);
  assert.match(text(labelled(view, '最新属性')[0]!), /别处改过的标题/);
  assert.match(text(labelled(view, '待提交属性修改')[0]!), /"status": "canceled"/);
  assert.ok(loadDraft(propertiesKey));

  fail = false;
  await click(view, '已核对，使用最新版本保存属性');
  assert.equal(plans.at(-1)!.baseRevision, 'r2');
  assert.deepEqual(plans.at(-1)!.operations, [
    { op: 'patch', id: 'task-a', expectedVersion: 'v2', changes: { status: 'canceled' } },
  ]);
  assert.equal(labelled(view, '属性冲突恢复').length, 0);
});

test('a rejected property change reports the concrete reason and keeps the draft', async t => {
  const task = makeTask();
  const { port } = portWith({
    record: () => makeRecord(task), state: () => makeState([task]),
    apply: async () => { throw Object.assign(new Error('Task task-a has unfinished prerequisites or children.'), { code: 'not_complete', hint: 'Complete prerequisites and finish or cancel child tasks first.' }); },
  });
  const view = await mount(t, createElement(TaskProperties, {
    task, record: makeRecord(task), port, state: makeState([task]), onChanged: async () => {}, onSelect: () => {},
  }));
  await act(async () => { field(view, '任务状态').props.onChange({ target: { value: 'done' } }); });
  await submit(view);
  const alert = view.root.findAllByType('pre').find(node => node.props.role === 'alert')!;
  assert.match(text(alert), /not_complete/);
  assert.match(text(alert), /unfinished prerequisites or children/);
  assert.match(text(alert), /Complete prerequisites/);
  assert.ok(loadDraft(propertiesKey));
});

test('a property edit reverted to the saved value clears the draft', async t => {
  const task = makeTask();
  const { port } = portWith({
    record: () => makeRecord(task), state: () => makeState([task]), apply: async () => applied(task.id, 'v2', 'r2'),
  });
  const view = await mount(t, createElement(TaskProperties, {
    task, record: makeRecord(task), port, state: makeState([task]), onChanged: async () => {}, onSelect: () => {},
  }));
  await act(async () => { field(view, '任务标题').props.onChange({ target: { value: '改名' } }); });
  assert.ok(loadDraft(propertiesKey));
  await act(async () => { field(view, '任务标题').props.onChange({ target: { value: task.title } }); });
  assert.equal(loadDraft(propertiesKey), undefined);
  assert.equal(button(view, '保存属性').props.disabled, true);
});

test('the properties draft survives a task switch and is restored on return', async t => {
  const a = makeTask();
  const b = makeTask({ id: 'task-b', title: '任务 B' });
  const { port } = portWith({
    record: () => makeRecord(a), state: () => makeState([a, b]), apply: async () => applied(a.id, 'v2', 'r2'),
  });
  const props = { port, state: makeState([a, b]), onChanged: async () => {}, onSelect: () => {}, onDirty: () => {} };
  let view = await mount(t, createElement(TaskProperties, { ...props, task: a, record: makeRecord(a) }));
  await act(async () => { field(view, '任务标题').props.onChange({ target: { value: 'A 改名' } }); });

  await rerender(view, createElement(TaskProperties, { ...props, task: b, record: makeRecord(b) }));
  assert.equal(field(view, '任务标题').props.value, '任务 B');
  assert.ok(loadDraft(propertiesKey), 'the draft for A is kept');

  await rerender(view, createElement(TaskProperties, { ...props, task: a, record: makeRecord(a) }));
  assert.equal(field(view, '任务标题').props.value, 'A 改名');
});

test('bodyDiff reports identical text, then a contiguous hunk of every changed line', () => {
  assert.match(bodyDiff('# 一\n', '# 一\n'), /正文相同/);
  const diff = bodyDiff('a\nb\nc\n', 'a\nB\nc\n');
  assert.match(diff, /^--- 最新正文\n\+\+\+ 本地草稿\n@@ 第 2 行起 @@/);
  assert.match(diff, /- b/);
  assert.match(diff, /\+ B/);
});

test('taskFailure surfaces code, message, hint and validation diagnostics', () => {
  const message = taskFailure(Object.assign(new Error('The final task graph is invalid.'), {
    code: 'validation_failed', hint: 'Fix all reported errors and retry.',
    details: [{ message: 'DEPENDENCY_SCOPE: Dependency task-x must share the same direct parent.' }],
  }));
  assert.match(message, /^validation_failed: The final task graph is invalid\./);
  assert.match(message, /Fix all reported errors and retry\./);
  assert.match(message, /DEPENDENCY_SCOPE/);
  assert.equal(isVersionConflict(Object.assign(new Error('x'), { code: 'version_conflict' })), true);
  assert.equal(isVersionConflict(Object.assign(new Error('x'), { code: 'validation_failed' })), false);
  assert.equal(isVersionConflict('version_conflict'), false);
});

test('draft storage reports refusal instead of throwing when the browser blocks it', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')!;
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } },
  });
  try {
    assert.equal(storeDraft(bodyKey, { body: 'x' }), false);
    assert.equal(storeDraft(bodyKey, undefined), false);
    assert.equal(loadDraft(bodyKey), undefined);
  } finally { Object.defineProperty(globalThis, 'sessionStorage', original); }
});

test('a body-only patch through the real Store keeps frontmatter comments and unknown fields', async () => {
  await withSandbox(async () => {
    const store = new Store();
    try {
      const initial = await store.state();
      const created = await store.apply({
        requestId: 'create-1', baseRevision: initial.revision,
        operations: [{ op: 'create', key: 'a', task: { title: '原标题' } }],
      });
      const id = created.ids.a!;
      const before = await store.read(id);
      const [frontmatter, ...rest] = before.content.split('---\n');
      // Add a comment and an unknown field, which the Store reports as warnings.
      const decorated = `---\n${rest[0]}# 保留的注释\nunknown_field: keep-me\n---\n${rest.slice(1).join('---\n')}`;
      assert.match(frontmatter!, /^$/);

      const replaced = await store.apply({
        requestId: 'decorate-1', baseRevision: (await store.state()).revision,
        operations: [{ op: 'replaceMarkdown', id, content: decorated, expectedVersion: before.version }],
      });
      const decoratedRecord = await store.read(id);
      assert.equal(decoratedRecord.version, replaced.versions[id]);

      const saved = await store.apply({
        requestId: 'body-1', baseRevision: (await store.state()).revision,
        operations: [{ op: 'patch', id, expectedVersion: decoratedRecord.version, changes: { body: '# 新正文\n' } }],
      });
      const afterBody = await store.read(id);
      assert.equal(afterBody.version, saved.versions[id]);
      assert.equal(afterBody.task.body, '# 新正文\n');
      assert.equal(afterBody.task.title, '原标题');
      assert.match(afterBody.content, /# 保留的注释/);
      assert.match(afterBody.content, /unknown_field: keep-me/);
      assert.equal(afterBody.content.slice(0, afterBody.content.length - '# 新正文\n'.length),
        decoratedRecord.content.slice(0, decoratedRecord.content.length - decoratedRecord.task.body.length));

      // A property patch leaves the body alone in the other direction.
      const titled = await store.apply({
        requestId: 'title-1', baseRevision: (await store.state()).revision,
        operations: [{ op: 'patch', id, expectedVersion: afterBody.version, changes: { title: '新标题' } }],
      });
      const afterTitle = await store.read(id);
      assert.equal(afterTitle.version, titled.versions[id]);
      assert.equal(afterTitle.task.title, '新标题');
      assert.equal(afterTitle.task.body, '# 新正文\n');
      assert.match(afterTitle.content, /# 保留的注释/);

      // A stale expectedVersion is the conflict the UI recovers from.
      await assert.rejects(
        store.apply({
          requestId: 'stale-1', baseRevision: (await store.state()).revision,
          operations: [{ op: 'patch', id, expectedVersion: decoratedRecord.version, changes: { body: '旧版本写入' } }],
        }),
        (error: unknown) => isVersionConflict(error),
      );
    } finally { store.close(); }
  });
});
