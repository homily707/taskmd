import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { TaskError, type State, type Task, type TaskChanges, type TaskRecord } from '../src/types.js';
import type { SessionCapability, TaskPort } from '../src/ui/port.js';
import { TaskmdApp, TaskmdDetailPanel, TaskmdSidebar } from '../src/ui/taskmd-app.js';
import { TaskmdLeftSidebar } from '../src/ui/left-sidebar.js';
import { TaskSessionLauncher, continueLaunch, type LaunchProgress } from '../src/ui/session-launcher.js';
import { outlineRows, movedOrder } from '../src/ui/outline-model.js';
import { MarkdownPreview } from '../src/ui/markdown-preview.js';
import { HomeConfiguration } from '../src/ui/settings.js';
import { TaskProperties } from '../src/ui/task-properties.js';
import { clearLocal } from '../src/ui/task-editing.js';

let serial = 0;
function record(id: string, changes: Partial<Task> = {}, path = `/home/test-${++serial}/tasks/${id}.md`): TaskRecord {
  return { task: { id, title: `Task ${id}`, status: 'todo', parent: null, order: 0, archived: false, body: '# Saved body', ...changes }, content: '', version: 'v1', path };
}
function fixture(records = [record('a')]) {
  let state: State = { settings: { homeDirectory: '/home', homeWorkspaceId: 'home', tasksDirectory: 'tasks' }, tasks: records, diagnostics: [] };
  const listeners = new Set<() => void>();
  const updates: { id: string; changes: TaskChanges; version: string }[] = [];
  const emit = () => { for (const fn of listeners) fn(); };
  const port: TaskPort = {
    getState: async () => state,
    configure: async settings => { state = { ...state, settings }; emit(); return state; },
    readTask: async id => { const value = state.tasks.find(item => item.task.id === id); if (!value) throw new TaskError('not_found', 'missing'); return value; },
    createTask: async input => { const value = record(`new-${serial}`, { title: input.title, parent: input.parent ?? null, body: input.body ?? '' }); state = { ...state, tasks: [...state.tasks, value] }; emit(); return value; },
    updateTask: async (id, changes, version) => {
      updates.push({ id, changes, version });
      const previous = await port.readTask(id);
      if (previous.version !== version) throw new TaskError('version_conflict', '文件已变化');
      const next = { ...previous, version: `v${Number(previous.version.slice(1)) + 1}`, task: { ...previous.task, ...changes } };
      state = { ...state, tasks: state.tasks.map(item => item.task.id === id ? next : item) }; emit(); return next;
    },
    deleteTask: async (id, _version) => {
      const doomed = new Set([id]);
      for (let growing = true; growing;) {
        growing = false;
        for (const item of state.tasks) if (item.task.parent && doomed.has(item.task.parent) && !doomed.has(item.task.id)) { doomed.add(item.task.id); growing = true; }
      }
      const removed = [...doomed];
      state = { ...state, tasks: state.tasks.filter(item => !doomed.has(item.task.id)) }; emit(); return removed;
    },
    readAttachment: async () => ({ path: '/home/image.png', mime: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { port, updates, state: () => state, external(id: string, changes: TaskChanges) {
    state = { ...state, tasks: state.tasks.map(item => item.task.id === id ? { ...item, version: `v${Number(item.version.slice(1)) + 1}`, task: { ...item.task, ...changes } } : item) }; emit();
  } };
}
function sessions(overrides: Partial<SessionCapability> = {}): SessionCapability {
  return { list: async () => [], open: async () => {}, create: async () => ({ sessionId: 's1' }), bind: async () => {}, unbind: async () => {}, workspaces: async () => [{ workspaceId: 'home', path: '/home', title: 'Home repo' }, { workspaceId: 'other', path: '/other', title: 'Other repo' }], ...overrides };
}
beforeEach(() => clearLocal());
async function mount(t: { after(fn: () => void): void }, element: React.ReactElement) {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(element); });
  t.after(() => { act(() => view.unmount()); });
  return view;
}
const text = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(text).join('');
async function click(view: ReactTestRenderer, label: string) {
  const button = view.root.findAllByType('button').find(node => text(node) === label);
  assert.ok(button, `missing button: ${label}`);
  await act(async () => { await button.props.onClick(); });
}
async function body(view: ReactTestRenderer, value: string) {
  const field = view.root.findByProps({ 'aria-label': 'Markdown 正文' });
  await act(async () => { field.props.onChange({ target: { value } }); });
}

test('outline hides archived subtrees and preserves ancestors in search', () => {
  const records = [record('p'), record('c', { parent: 'p' }), record('hidden', { archived: true }), record('hc', { parent: 'hidden' })];
  assert.deepEqual(outlineRows(records).map(row => row.task.id), ['p', 'c']);
  assert.deepEqual(outlineRows(records, new Set(), false, 'Task c').map(row => row.task.id), ['p', 'c']);
  assert.equal(outlineRows(records, new Set(), true).length, 4);
  assert.deepEqual(outlineRows(records, new Set(['p'])).map(row => row.task.id), ['p']);
});
test('sibling order moves use a single numeric update', () => {
  const tasks = [record('a', { order: 0 }).task, record('b', { order: 10 }).task, record('c', { order: 20 }).task];
  assert.equal(movedOrder(tasks, 'a', 1), 15);
  assert.equal(movedOrder(tasks, 'c', -1), 5);
  assert.equal(movedOrder(tasks, 'a', -1), undefined);
});
test('task row enters its first Session; a sessionless task opens Markdown', async t => {
  const f = fixture([record('a'), record('b')]);
  const openedTasks: string[] = []; const openedSessions: string[] = [];
  const capability = sessions({
    list: async () => [
      { taskId: 'a', sessionId: 's1', createdAt: '2026-01-01T00:00:00Z' },
      { taskId: 'a', sessionId: 's2', createdAt: '2026-01-02T00:00:00Z' },
    ],
    open: async id => { openedSessions.push(id); },
  });
  const view = await mount(t, createElement(TaskmdLeftSidebar, { port: f.port, sessions: capability, wide: true, expandSidebar() {}, showSessions() {}, onOpenTask: id => openedTasks.push(id) }));
  // The whole row is one hit target; the latest binding is entered first.
  const row = view.root.findAllByType('button').find(node => node.props.className === 'taskmd-nav-hit' && node.props['aria-label'].includes('Task a'))!;
  await act(async () => { await row.props.onClick(); });
  assert.deepEqual(openedSessions, ['s2']);
  assert.deepEqual(openedTasks, []);
  assert.doesNotMatch(text(view.root), /s1/);
  const badge = view.root.findAllByType('button').find(node => node.props.className?.includes('taskmd-session-badge') && text(node) === '2')!;
  assert.ok(badge);
  const rowB = view.root.findAllByType('button').find(node => node.props.className === 'taskmd-nav-hit' && node.props['aria-label'].includes('Task b'))!;
  await act(async () => { await rowB.props.onClick(); });
  assert.deepEqual(openedTasks, ['b']);
  assert.deepEqual(openedSessions, ['s2']);
});
test('left sidebar shows the five most recently updated Sessions, including unbound ones', async t => {
  const f = fixture([record('a')]);
  const statuses = new Map([
    ['s1', { sessionId: 's1', running: true, updatedAt: 10 }],
    ['s2', { sessionId: 's2', running: false, pending: 'approval' as const, updatedAt: 20 }],
    ['s3', { sessionId: 's3', running: false, fresh: true, title: '不在任务里的会话', updatedAt: 30 }],
  ]);
  const opened: string[] = [];
  const capability = sessions({
    list: async () => [
      { taskId: 'a', sessionId: 's1', createdAt: '2026-01-01T00:00:00Z' },
      { taskId: 'a', sessionId: 's2', createdAt: '2026-01-02T00:00:00Z' },
    ],
    statuses: () => ({ get: () => statuses, subscribe: () => () => {} }),
    open: async id => { opened.push(id); },
  });
  const view = await mount(t, createElement(TaskmdLeftSidebar, { port: f.port, sessions: capability, wide: true, expandSidebar() {}, showSessions() {}, onOpenTask() {} }));
  // The cross-task block lists all three Sessions, including the one no Task binds.
  assert.match(text(view.root), /最近会话/);
  assert.match(text(view.root), /不在任务里的会话/);
  assert.ok(view.root.findAllByProps({ className: 'taskmd-session-dot is-attention' }).length > 0);
  assert.ok(view.root.findAllByProps({ className: 'taskmd-session-dot is-running' }).length > 0);
  assert.ok(view.root.findAllByProps({ className: 'taskmd-session-dot is-fresh' }).length > 0);
  const unbound = view.root.findAllByType('button').find(node => text(node).includes('不在任务里的会话'))!;
  await act(async () => { await unbound.props.onClick(); });
  assert.deepEqual(opened, ['s3']);
  // The Task row carries one compact, warning-tinted count instead of inline session rows.
  const badge = view.root.findAllByType('button').find(node => node.props.className === 'taskmd-session-badge is-attention')!;
  assert.equal(text(badge), '⚠ 2');
});
test('recent Sessions are capped at five rows sorted by latest update', async t => {
  const f = fixture([record('a')]);
  const statuses = new Map([
    ['s1', { sessionId: 's1', running: false, title: '最旧会话', updatedAt: 100 }],
    ['s2', { sessionId: 's2', running: false, title: '第五近会话', updatedAt: 200 }],
    ['s3', { sessionId: 's3', running: false, title: '第四近会话', updatedAt: 300 }],
    ['s4', { sessionId: 's4', running: false, title: '第三近会话', updatedAt: 400 }],
    ['s5', { sessionId: 's5', running: false, title: '次近会话', updatedAt: 500 }],
    ['s6', { sessionId: 's6', running: false, title: '最近会话', updatedAt: 600 }],
  ]);
  const capability = sessions({ statuses: () => ({ get: () => statuses, subscribe: () => () => {} }) });
  const view = await mount(t, createElement(TaskmdLeftSidebar, { port: f.port, sessions: capability, wide: true, expandSidebar() {}, showSessions() {}, onOpenTask() {} }));
  const copy = text(view.root);
  assert.match(copy, /最近会话/); assert.match(copy, /最近会话/); assert.match(copy, /次近会话/); assert.match(copy, /第三近会话/); assert.match(copy, /第四近会话/); assert.match(copy, /第五近会话/);
  assert.doesNotMatch(copy, /最旧会话/);
});
test('entering a Session highlights its bound task row; an unbound Session selects nothing', async t => {
  const f = fixture([record('a'), record('b')]);
  const capability = sessions({ list: async () => [{ taskId: 'b', sessionId: 's-live', createdAt: '2026-01-01T00:00:00Z' }] });
  const props = { port: f.port, sessions: capability, wide: true, expandSidebar() {}, showSessions() {}, onOpenTask() {} };
  const view = await mount(t, createElement(TaskmdLeftSidebar, props));
  // A manual pick highlights its own row while no Session is active.
  const rowA = view.root.findAllByProps({ className: 'taskmd-nav-hit' }).find(node => node.props['aria-label'].includes('Task a'))!;
  await act(async () => { rowA.props.onClick(); });
  assert.equal(view.root.findAllByProps({ className: 'taskmd-nav-hit' }).find(node => node.props['aria-label'].includes('Task a'))!.props['aria-current'], 'true');
  // Entering a bound Session moves the highlight to its Task.
  await act(async () => view.update(createElement(TaskmdLeftSidebar, { ...props, activeSessionId: 's-live' })));
  assert.equal(view.root.findAllByProps({ className: 'taskmd-nav-hit' }).find(node => node.props['aria-label'].includes('Task b'))!.props['aria-current'], 'true');
  assert.equal(view.root.findAllByProps({ className: 'taskmd-nav-hit' }).find(node => node.props['aria-label'].includes('Task a'))!.props['aria-current'], undefined);
  // An active Session with no bound Task clears the highlight instead of keeping the stale pick.
  await act(async () => view.update(createElement(TaskmdLeftSidebar, { ...props, activeSessionId: 's-unbound' })));
  assert.ok(view.root.findAllByProps({ 'aria-current': 'true' }).length === 0);
});
test('body draft survives navigation and external conflict without creating Session', async t => {
  const f = fixture([record('a'), record('b')]); let creates = 0;
  const capability = sessions({ create: async () => { creates++; return { sessionId: 's1' }; } });
  const props = { port: f.port, sessions: capability, taskId: 'a' };
  const view = await mount(t, createElement(TaskmdDetailPanel, props));
  await click(view, '编辑正文'); await body(view, 'my draft');
  await act(async () => view.update(createElement(TaskmdDetailPanel, { ...props, taskId: 'b' })));
  await act(async () => view.update(createElement(TaskmdDetailPanel, props)));
  assert.equal(view.root.findByProps({ 'aria-label': 'Markdown 正文' }).props.value, 'my draft');
  await act(async () => f.external('a', { body: 'external body' }));
  assert.match(text(view.root), /文件正文已变化/);
  await click(view, '保存并启动 Session'); assert.equal(creates, 0);
  assert.equal(view.root.findByProps({ 'aria-label': 'Markdown 正文' }).props.value, 'my draft');
  await click(view, '已核对，以最新版本为基础保留草稿'); await click(view, '保存正文');
  assert.equal(f.state().tasks[0]!.task.body, 'my draft');
});
test('status-only external change rebases body save and retains manual four states', async t => {
  const f = fixture(); const view = await mount(t, createElement(TaskmdDetailPanel, { port: f.port, taskId: 'a' }));
  await click(view, '编辑正文'); await body(view, 'draft after status');
  const select = view.root.findByProps({ 'aria-label': '任务状态' });
  assert.deepEqual(select.findAllByType('option').map(node => node.props.value), ['todo', 'in_progress', 'done', 'canceled']);
  await act(async () => select.props.onChange({ target: { value: 'done' } }));
  await click(view, '保存正文');
  assert.equal(f.state().tasks[0]!.task.status, 'done'); assert.equal(f.state().tasks[0]!.task.body, 'draft after status');
  assert.equal(f.updates.at(-1)?.version, 'v2');
});
test('launcher defaults to Home, offers all repos, and sends saved snapshot', async t => {
  const f = fixture(); const events: string[] = []; let createdOptions: unknown; let sentText = '';
  const update = f.port.updateTask;
  f.port.updateTask = async (...args) => { events.push('save'); return update(...args); };
  const capability = sessions({ create: async (_id, options) => { events.push('create'); createdOptions = options; return { sessionId: 's1' }; }, send: async (_id, value) => { events.push('send'); sentText = value; }, open: async () => { events.push('open'); } });
  const view = await mount(t, createElement(TaskmdDetailPanel, { port: f.port, sessions: capability, taskId: 'a' }));
  const repo = view.root.findByProps({ 'aria-label': 'Session 仓库' });
  assert.equal(repo.props.value, 'home'); assert.deepEqual(repo.findAllByType('option').map(node => node.props.value), ['', 'home', 'other']);
  await click(view, '编辑正文'); await body(view, 'fresh saved body'); await click(view, '保存并启动 Session');
  assert.deepEqual(events, ['save', 'create', 'send', 'open']); assert.deepEqual(createdOptions, { workspaceId: 'home' }); assert.match(sentText, /fresh saved body/);
});
test('bind and send retries reuse created Session and exact request/text', async () => {
  const calls: string[] = []; const deliveries: string[] = []; let bindFails = true; let sendFails = true;
  const capability = sessions({
    create: async () => { calls.push('create'); throw new TaskError('bind_failed', 'bind failed', { sessionId: 'existing' }); },
    bind: async (_task, id) => { calls.push(`bind:${id}`); if (bindFails) { bindFails = false; throw new Error('temporary'); } },
    send: async (id, message, requestId) => { deliveries.push(JSON.stringify([id, message, requestId])); if (sendFails) { sendFails = false; throw new Error('ack lost'); } },
    open: async id => { calls.push(`open:${id}`); },
  });
  const progress: LaunchProgress = { requestId: 'fixed', text: 'snapshot', workspaceId: 'home', preset: '' };
  await assert.rejects(continueLaunch(capability, 'a', progress, () => {}));
  await assert.rejects(continueLaunch(capability, 'a', progress, () => {}));
  await assert.rejects(continueLaunch(capability, 'a', progress, () => {}));
  await continueLaunch(capability, 'a', progress, () => {});
  assert.equal(calls.filter(value => value === 'create').length, 1);
  assert.equal(deliveries.length, 2); assert.equal(deliveries[0], deliveries[1]); assert.equal(progress.opened, true);
});
test('unknown creation outcome never automatically creates a duplicate', async () => {
  let creates = 0;
  const capability = sessions({ create: async () => { creates++; throw new Error('connection lost after creation'); } });
  const progress: LaunchProgress = { requestId: 'unknown', text: 'snapshot', workspaceId: 'home', preset: '' };
  await assert.rejects(continueLaunch(capability, 'a', progress, () => {}));
  await assert.rejects(continueLaunch(capability, 'a', progress, () => {}), /创建结果不明/);
  assert.equal(creates, 1);
});
test('send retry survives component remount and does not reread changed body', async t => {
  const target = record('retry'); let creates = 0; let attempts = 0; const deliveries: string[] = [];
  const capability = sessions({ create: async () => { creates++; return { sessionId: 'retry-session' }; }, send: async (_id, message, request) => { deliveries.push(`${request}:${message}`); if (++attempts === 1) throw new Error('ack lost'); } });
  const props = { record: target, settings: fixture().state().settings, capability, save: async () => target, onChanged() {} };
  const view = await mount(t, createElement(TaskSessionLauncher, props));
  await click(view, '保存并启动 Session');
  await act(async () => view.update(createElement('div')));
  await act(async () => view.update(createElement(TaskSessionLauncher, { ...props, save: async () => { throw new Error('must not resave'); } })));
  await click(view, '继续上次启动');
  assert.equal(creates, 1); assert.equal(deliveries[0], deliveries[1]);
});
test('new edits made during save survive completion as a new draft', async t => {
  const f = fixture(); const update = f.port.updateTask; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.port.updateTask = async (...args) => { await gate; return update(...args); };
  const view = await mount(t, createElement(TaskmdDetailPanel, { port: f.port, taskId: 'a' }));
  await click(view, '编辑正文'); await body(view, 'first snapshot');
  const save = view.root.findAllByType('button').find(node => text(node) === '保存正文')!;
  await act(async () => { save.props.onClick(); });
  await body(view, 'later draft');
  await body(view, '# Saved body');
  await act(async () => { release(); });
  assert.equal(f.state().tasks[0]!.task.body, 'first snapshot');
  assert.equal(view.root.findByProps({ 'aria-label': 'Markdown 正文' }).props.value, '# Saved body');
});
test('save completion after navigation preserves a newer draft reverted to original text', async t => {
  const f = fixture([record('a'), record('b')]); const update = f.port.updateTask; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.port.updateTask = async (...args) => { await gate; return update(...args); };
  const props = { port: f.port, taskId: 'a' };
  const view = await mount(t, createElement(TaskmdDetailPanel, props));
  await click(view, '编辑正文'); await body(view, 'submitted snapshot');
  await click(view, '保存正文');
  await act(async () => view.update(createElement(TaskmdDetailPanel, { ...props, taskId: 'b' })));
  await act(async () => view.update(createElement(TaskmdDetailPanel, props)));
  await body(view, 'newer draft after navigation');
  await act(async () => { release(); });
  assert.equal(view.root.findByProps({ 'aria-label': 'Markdown 正文' }).props.value, 'newer draft after navigation');
  assert.doesNotMatch(text(view.root), /文件正文已变化/);
  await body(view, '# Saved body');
  await click(view, '保存正文');
  assert.equal(f.state().tasks[0]!.task.body, '# Saved body');
});

test('Sidebar shows currently bound task with header archive and confirmed cascade delete', async t => {
  const f = fixture([record('a'), record('child', { parent: 'a' })]);
  const capability = sessions({ list: async () => [{ taskId: 'a', sessionId: 'current', createdAt: '' }] });
  const view = await mount(t, createElement(TaskmdSidebar, { port: f.port, sessions: capability, sessionId: 'current', onOpenTask() {} }));
  assert.match(text(view.root), /Task a/);
  // Archive is one click in the header.
  await click(view, '归档任务'); assert.equal(f.state().tasks.find(item => item.task.id === 'a')!.task.archived, true);
  await click(view, '恢复任务'); assert.equal(f.state().tasks.find(item => item.task.id === 'a')!.task.archived, false);
  // Delete needs a second confirming click, then removes the subtree.
  await click(view, '删除任务');
  assert.equal(f.state().tasks.length, 2);
  assert.match(text(view.root), /含 1 个子任务/);
  await click(view, '确认删除（含 1 个子任务）');
  assert.equal(f.state().tasks.length, 0);
});
test('relative Markdown image uses attachment port and executable links stay inert', async t => {
  const f = fixture(); const reads: string[] = []; const read = f.port.readAttachment;
  f.port.readAttachment = async (id, href) => { reads.push(`${id}:${href}`); return read(id, href); };
  const view = await mount(t, createElement(MarkdownPreview, { text: '![diagram](../assets/a.png) [unsafe](javascript:alert) [web](https://example.com)', port: f.port, taskId: 'a' }));
  assert.deepEqual(reads, ['a:../assets/a.png']); assert.equal(view.root.findByType('img').props.alt, 'diagram');
  assert.deepEqual(view.root.findAllByType('a').map(node => node.props.href), ['https://example.com']);
});
test('App has no graph or repository task fields and creates task through port', async t => {
  const f = fixture(); const view = await mount(t, createElement(TaskmdApp, { port: f.port, sessions: sessions() }));
  assert.doesNotMatch(text(view.root), /Task Graph|blocked_by|Asset/);
  const input = view.root.findByProps({ 'aria-label': '任务标题' });
  await act(async () => input.props.onChange({ target: { value: 'Created from UI' } }));
  const form = view.root.findAllByType('form')[0]!;
  await act(async () => form.props.onSubmit({ preventDefault() {} }));
  assert.ok(f.state().tasks.some(item => item.task.title === 'Created from UI'));
});

test('Home configuration selects a DSH workspace and configurable relative task directory', async t => {
  const f = fixture();
  const view = await mount(t, createElement(HomeConfiguration, { settings: f.state().settings, port: f.port, sessions: sessions(), onChanged: async () => {} }));
  await act(async () => view.root.findByType('select').props.onChange({ target: { value: 'other' } }));
  await act(async () => view.root.findByType('input').props.onChange({ target: { value: 'notes/tasks' } }));
  await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(f.state().settings, { homeDirectory: '/other', homeWorkspaceId: 'other', tasksDirectory: 'notes/tasks' });
});
test('parent selection excludes descendants and metadata edits apply', async t => {
  const f = fixture([record('a'), record('child', { parent: 'a' }), record('other', { order: 10 })]);
  const props = () => ({ record: f.state().tasks[0]!, state: f.state(), port: f.port, onChanged: async () => {} });
  const view = await mount(t, createElement(TaskProperties, props()));
  assert.deepEqual(view.root.findByType('select').findAllByType('option').map(node => node.props.value), ['', 'other']);
  await act(async () => view.root.findByType('select').props.onChange({ target: { value: 'other' } }));
  await act(async () => view.root.findAllByType('input')[0]!.props.onChange({ target: { value: 'Edited task' } }));
  await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  assert.equal(f.state().tasks[0]!.task.parent, 'other'); assert.equal(f.state().tasks[0]!.task.title, 'Edited task');
});
test('model, effort and preset are applied before saved snapshot delivery', async t => {
  const target = record('model'); const events: unknown[] = [];
  const capability = sessions({ catalog: async () => ({ default: { provider: 'p', model: 'm' }, routableProviders: ['p'], groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] }], failures: [] }),
    create: async (_task, options) => { events.push(options); return { sessionId: 's' }; },
    selectModel: async (id, model) => { events.push([id, model]); }, send: async () => { events.push('send'); },
  });
  const view = await mount(t, createElement(TaskSessionLauncher, { record: target, settings: fixture().state().settings, capability, save: async () => target, onChanged() {} }));
  await act(async () => view.root.findAllByType('input')[0]!.props.onChange({ target: { value: 'coder' } }));
  await act(async () => view.root.findAllByType('select')[1]!.props.onChange({ target: { value: JSON.stringify(['p', 'm']) } }));
  await act(async () => view.root.findAllByType('select')[2]!.props.onChange({ target: { value: 'high' } }));
  await click(view, '保存并启动 Session');
  assert.deepEqual(events, [{ workspaceId: 'home', agentPreset: 'coder' }, ['s', { provider: 'p', model: 'm', reasoningEffort: 'high' }], 'send']);
});
test('remount during pending creation reuses progress and prevents concurrent launch', async t => {
  const target = record('inflight'); let creates = 0; let release!: (value: { sessionId: string }) => void;
  const pending = new Promise<{ sessionId: string }>(resolve => { release = resolve; });
  const capability = sessions({ create: async () => { creates++; return pending; } });
  const props = { record: target, settings: fixture().state().settings, capability, save: async () => target, onChanged() {} };
  const first = await mount(t, createElement(TaskSessionLauncher, props));
  await click(first, '保存并启动 Session');
  await act(async () => first.update(createElement('div')));
  const second = await mount(t, createElement(TaskSessionLauncher, props));
  await click(second, '继续上次启动');
  assert.match(text(second.root), /另一个面板/);
  await act(async () => { release({ sessionId: 'single' }); });
  await click(second, '继续上次启动');
  assert.equal(creates, 1); assert.match(text(second.root), /已发送并打开 Session/); assert.doesNotMatch(text(second.root), /创建结果不明/);
});


test('repeated sidebar request reselects the same task after panel navigation', async t => {
  const f = fixture([record('a'), record('b')]);
  const props = { port: f.port, initialTaskId: 'a', selectionToken: 1 };
  const view = await mount(t, createElement(TaskmdApp, props));
  const b = view.root.findAllByType('button').find(node => node.props.className === 'taskmd-outline-label' && text(node).startsWith('Task b'))!;
  await act(async () => b.props.onClick());
  assert.equal(text(view.root.findAllByType('article')[0]!.findByType('h2')), 'Task b');
  await act(async () => view.update(createElement(TaskmdApp, { ...props, selectionToken: 2 })));
  assert.equal(text(view.root.findAllByType('article')[0]!.findByType('h2')), 'Task a');
});

test('unavailable Home leaves explicit configuration controls accessible', async t => {
  const f = fixture();
  f.port.getState = async () => { throw new Error('Home unavailable'); };
  const view = await mount(t, createElement(TaskmdApp, { port: f.port, sessions: sessions() }));
  assert.match(text(view.root), /Home unavailable/);
  assert.equal(view.root.findAllByType(HomeConfiguration).length, 1);
  assert.equal(f.updates.length, 0);
});
