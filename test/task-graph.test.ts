import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { Task, State } from '../src/types.js';

/**
 * The graph is exercised through the real ReactFlow renderer, so this file
 * supplies the browser globals ReactFlow reads at import/mount time. They are
 * inert stand-ins: every assertion below is about props the component derives,
 * not about measurement or painting.
 */
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) return { url: 'data:text/javascript,export default "";', shortCircuit: true };
  return next(specifier, context);
}
`));
const g = globalThis as any;
const element = (): any => ({
  addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {},
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 900, height: 600, top: 0, left: 0, right: 900, bottom: 600 }),
  offsetWidth: 900, offsetHeight: 600, style: {}, focus() {}, contains: () => false,
  setAttribute() {}, getAttribute: () => null, closest: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  ownerDocument: { addEventListener() {}, removeEventListener() {} },
});
g.requestAnimationFrame = (callback: any) => setTimeout(() => callback(Date.now()), 0);
g.cancelAnimationFrame = (id: any) => clearTimeout(id);
g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
g.DOMMatrixReadOnly = class { m22 = 1; };
g.window = g;
g.window.addEventListener = () => {};
g.window.removeEventListener = () => {};
g.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.window.getComputedStyle = () => ({ zIndex: '1' });
g.document = { querySelector: () => null, querySelectorAll: () => [], createElement: element, addEventListener() {}, removeEventListener() {} };

const { ReactFlow } = await import('@xyflow/react');
const { TaskGraph, graphStyles } = await import('../src/ui/task-graph.js');

let counter = 0;
function task(id: string, parent: string | null, overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    schema: 1, id, title: id.toUpperCase(), status: 'todo', parent, blocked_by: [],
    order: `a${String(counter).padStart(2, '0')}`, repo: null, assets: [], archived: false, body: '',
    ...overrides,
  };
}
function state(tasks: Task[], overrides: Partial<State> = {}): State {
  return { schemaVersion: 1, revision: 'r1', tasks, diagnostics: [], ready: [], ...overrides };
}
function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}
function render(view: ReactTestRenderer) { return view.root.findAllByType('button'); }
function labelled(view: ReactTestRenderer, label: string) {
  return render(view).find(node => node.props['aria-label'] === label || text(node) === label);
}
async function mount(t: { after(fn: () => void): void }, props: Parameters<typeof TaskGraph>[0]) {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(TaskGraph, props), { createNodeMock: element }); });
  t.after(() => act(() => view.unmount()));
  return view;
}
/** ReactFlow's own props are the component's declared output: nodes and edges. */
function flow(view: ReactTestRenderer) {
  const props = view.root.findByType(ReactFlow).props as {
    nodes: { id: string; type?: string; parentId?: string; position: { x: number; y: number }; data: any }[];
    edges: { id: string; source: string; target: string; label?: unknown; style?: { strokeDasharray?: string }; markerEnd?: unknown }[];
  };
  return {
    nodes: props.nodes,
    edges: props.edges,
    tasks: props.nodes.filter(node => node.type === 'task'),
    frames: props.nodes.filter(node => node.type === 'frame'),
    solid: props.edges.filter(edge => edge.id.startsWith('dependency:')),
    dashed: props.edges.filter(edge => edge.id.startsWith('children:')),
  };
}

test('one frame per direct parent; siblings of another parent never share it', async t => {
  const tasks = [
    task('root', null, { order: 'a0' }),
    task('a', 'root', { order: 'a0' }),
    task('b', 'root', { order: 'a1', blocked_by: ['a'] }),
    task('x', 'a', { order: 'a0' }),
  ];
  const view = await mount(t, { tasks, ready: [], selected: 'a', onSelect() {}, state: state(tasks), initialScope: 'root' });
  const { frames, tasks: cards } = flow(view);
  assert.deepEqual(frames.map(frame => frame.id), ['graph-frame:root']);
  assert.deepEqual(cards.map(card => card.id).sort(), ['a', 'b']);
  for (const card of cards) assert.equal(card.parentId, 'graph-frame:root');
  assert.equal(cards.find(card => card.id === 'x'), undefined, 'collapsed descendants stay out of the canvas');
});

test('the root frame holds only root tasks', async t => {
  const tasks = [task('root', null), task('a', 'root'), task('other', null), task('x', 'a')];
  const view = await mount(t, { tasks, ready: [], onSelect() {}, state: state(tasks), initialScope: null });
  const { tasks: cards } = flow(view);
  assert.deepEqual(cards.map(card => card.id).sort(), ['other', 'root']);
});

test('expanding a parent adds exactly one dashed guide, never a parent-child arrow', async t => {
  const tasks = [
    task('root', null, { order: 'a0' }),
    task('b', 'root', { order: 'a0' }),
    task('x', 'b', { order: 'a0' }),
    task('y', 'b', { order: 'a1', blocked_by: ['x'] }),
    task('z', 'b', { order: 'a2' }),
  ];
  const view = await mount(t, { tasks, ready: [], onSelect() {}, state: state(tasks), initialScope: 'root' });
  assert.equal(flow(view).dashed.length, 0);
  await act(async () => { labelled(view, '展开 B 的子图')!.props.onClick(); });
  const after = flow(view);
  assert.deepEqual(after.dashed.map(edge => [edge.source, edge.target]), [['b', 'graph-frame:b']]);
  assert.equal(after.dashed[0]!.style?.strokeDasharray, '6 5');
  // Only the sibling dependency x -> y is solid; no b -> x, b -> y or b -> z edge.
  assert.deepEqual(after.solid.map(edge => [edge.source, edge.target]), [['x', 'y']]);
  assert.ok(after.solid.every(edge => edge.markerEnd), 'solid dependency edges carry an arrow head');
  // The child frame contains exactly b's direct children.
  assert.deepEqual(after.tasks.filter(card => card.parentId === 'graph-frame:b').map(card => card.id).sort(), ['x', 'y', 'z']);
  assert.deepEqual(after.tasks.filter(card => card.parentId === 'graph-frame:root').map(card => card.id), ['b']);
});

test('a parent-child relationship never becomes a solid dependency edge', async t => {
  const tasks = [task('root', null), task('a', 'root'), task('x', 'a', { blocked_by: [] })];
  const view = await mount(t, { tasks, ready: [], onSelect() {}, state: state(tasks), initialScope: 'root' });
  await act(async () => { labelled(view, '展开 A 的子图')!.props.onClick(); });
  assert.deepEqual(flow(view).solid, []);
});

test('a chain and its islands keep independent, non-overlapping boxes', async t => {
  const tasks = [
    task('root', null, { order: 'a0' }),
    task('a', 'root', { order: 'a0' }),
    task('b', 'root', { order: 'a1', blocked_by: ['a'] }),
    task('c', 'root', { order: 'a2' }),
    task('d', 'root', { order: 'a3' }),
  ];
  const view = await mount(t, { tasks, ready: [], onSelect() {}, state: state(tasks), initialScope: 'root' });
  const { solid, tasks: cards } = flow(view);
  assert.deepEqual(solid.map(edge => [edge.source, edge.target]), [['a', 'b']]);
  assert.equal(cards.length, 4);
  const boxes = cards.map(card => ({ id: card.id, x: card.position.x, y: card.position.y }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const left = boxes[i]!, right = boxes[j]!;
    const overlap = left.x < right.x + 232 && right.x < left.x + 232 && left.y < right.y + 132 && right.y < left.y + 132;
    assert.ok(!overlap, `${left.id} overlaps ${right.id}`);
  }
});

test('collapsing a parent removes its frame, guide and descendants again', async t => {
  const tasks = [task('root', null), task('a', 'root'), task('x', 'a'), task('y', 'x')];
  const view = await mount(t, { tasks, ready: [], onSelect() {}, state: state(tasks), initialScope: 'root' });
  await act(async () => { labelled(view, '展开 A 的子图')!.props.onClick(); });
  await act(async () => { labelled(view, '展开 X 的子图')!.props.onClick(); });
  assert.deepEqual(flow(view).frames.map(frame => frame.id), ['graph-frame:root', 'graph-frame:a', 'graph-frame:x']);
  await act(async () => { labelled(view, '收起 A 的子图')!.props.onClick(); });
  const after = flow(view);
  assert.deepEqual(after.frames.map(frame => frame.id), ['graph-frame:root']);
  assert.deepEqual(after.dashed, []);
  assert.deepEqual(after.tasks.map(card => card.id), ['a']);
});

test('entering a subgraph and returning through the breadcrumb keeps data intact', async t => {
  const tasks = [task('root', null), task('a', 'root'), task('x', 'a'), task('y', 'a', { blocked_by: ['x'] })];
  const snapshot = JSON.stringify(tasks);
  const view = await mount(t, { tasks, ready: [], onSelect() {}, state: state(tasks), initialScope: 'root' });
  await act(async () => { labelled(view, '进入 A 的子图')!.props.onClick(); });
  const entered = flow(view);
  assert.deepEqual(entered.frames.map(frame => frame.id), ['graph-frame:a']);
  assert.deepEqual(entered.tasks.map(card => card.id).sort(), ['x', 'y']);
  assert.deepEqual(entered.solid.map(edge => [edge.source, edge.target]), [['x', 'y']]);
  // Breadcrumb: 根任务 / ROOT / A, with A marked as the current page.
  const nav = view.root.findByProps({ 'aria-label': '图范围面包屑' });
  assert.deepEqual(nav.findAllByType('button').map(text), ['根任务', 'ROOT', 'A']);
  assert.equal(nav.findAllByType('button').find(node => text(node) === 'A')!.props['aria-current'], 'page');
  await act(async () => { nav.findAllByType('button').find(node => text(node) === '根任务')!.props.onClick(); });
  assert.deepEqual(flow(view).frames.map(frame => frame.id), ['graph-frame:root']);
  assert.equal(JSON.stringify(tasks), snapshot, 'navigation never mutates task data');
});

test('the initial scope follows the selection when the caller does not pin one', async t => {
  const tasks = [task('root', null), task('a', 'root'), task('b', 'root'), task('x', 'a'), task('y', 'b')];
  const view = await mount(t, { tasks, ready: [], selected: 'a', onSelect() {}, state: state(tasks) });
  assert.deepEqual(flow(view).frames.map(frame => frame.id), ['graph-frame:root']);
  assert.deepEqual(flow(view).tasks.map(card => card.id).sort(), ['a', 'b']);
  // A later selection change outside the frame pulls the scope to its parent.
  await act(async () => { view.update(createElement(TaskGraph, { tasks, ready: [], selected: 'y', onSelect() {}, state: state(tasks) })); });
  const after = flow(view);
  assert.deepEqual(after.frames.map(frame => frame.id), ['graph-frame:b']);
  assert.deepEqual(after.tasks.map(card => card.id), ['y']);
});

test('an explicit initialScope wins over the selection', async t => {
  const tasks = [task('root', null), task('a', 'root'), task('x', 'a')];
  const view = await mount(t, { tasks, ready: [], selected: 'x', onSelect() {}, state: state(tasks), initialScope: null });
  assert.deepEqual(flow(view).frames.map(frame => frame.id), ['graph-frame:root']);
  assert.deepEqual(flow(view).tasks.map(card => card.id), ['root']);
});

test('a changed initialScope is honoured like a caller-driven navigation', async t => {
  const tasks = [task('root', null), task('a', 'root'), task('x', 'a')];
  const view = await mount(t, { tasks, ready: [], selected: 'root', onSelect() {}, state: state(tasks), initialScope: null });
  await act(async () => { view.update(createElement(TaskGraph, { tasks, ready: [], selected: 'root', onSelect() {}, state: state(tasks), initialScope: 'a' })); });
  assert.deepEqual(flow(view).frames.map(frame => frame.id), ['graph-frame:a']);
  assert.deepEqual(flow(view).tasks.map(card => card.id), ['x']);
});

test('the node label shows only the four-state status text, plus a derived ready hint', async t => {
  const tasks = [
    task('root', null, { status: 'in_progress' }),
    task('a', 'root', { status: 'todo' }),
    task('b', 'root', { status: 'done' }),
    task('c', 'root', { status: 'canceled' }),
  ];
  const view = await mount(t, { tasks, ready: ['a'], onSelect() {}, state: state(tasks, { ready: ['a'] }), initialScope: 'root' });
  const body = text(view.root.findByProps({ className: 'taskmd-graph-shell' }));
  for (const label of ['待办', '完成', '取消']) assert.ok(body.includes(label), `missing ${label}`);
  assert.ok(body.includes('可开始'), 'a ready task says it can start');
  // Ready is derived, never a stored status: no task gained a status field.
  assert.deepEqual(tasks.map(item => item.status), ['in_progress', 'todo', 'done', 'canceled']);
});

test('a child frame still opens when its parent waits, and the heading names the blocker', async t => {
  const tasks = [
    task('root', null, { order: 'a0' }),
    task('a', 'root', { order: 'a0', status: 'in_progress' }),
    task('b', 'root', { order: 'a1', blocked_by: ['a'] }),
    task('x', 'b', { order: 'a0' }),
  ];
  const view = await mount(t, { tasks, ready: [], onSelect() {}, state: state(tasks), initialScope: 'root' });
  await act(async () => { labelled(view, '展开 B 的子图')!.props.onClick(); });
  const frame = flow(view).frames.find(item => item.id === 'graph-frame:b')!;
  assert.equal(frame.data.waiting, '等待 A');
  const headings = view.root.findAllByProps({ className: 'taskmd-graph-frame-heading' }).map(text);
  assert.ok(headings.some(heading => heading.includes('等待 A')), headings.join(' | '));
  // The sibling dependency A -> B is the only solid arrow; nothing points at X,
  // so the ancestor relation is not redrawn as an inherited dependency.
  assert.deepEqual(flow(view).solid.map(edge => [edge.source, edge.target]), [['a', 'b']]);
  assert.ok(flow(view).solid.every(edge => edge.target !== 'x'));
});

test('a cross-parent dependency is reported in the UI instead of disappearing', async t => {
  const tasks = [
    task('root', null),
    task('a', 'root'),
    task('b', 'root'),
    task('x', 'a', { blocked_by: ['b'] }),
  ];
  const view = await mount(t, { tasks, ready: [], onSelect() {}, state: state(tasks), initialScope: 'a' });
  const panel = view.root.findByProps({ className: 'taskmd-graph-diagnostics' });
  const body = text(panel).toLowerCase();
  assert.ok(body.includes('dependency_scope') || body.includes('cross_parent_dependency'), body);
  assert.ok(body.includes('b'), body);
  // The illegal edge is not redrawn as a solid cross-frame arrow.
  assert.deepEqual(flow(view).solid, []);
  const card = flow(view).tasks.find(item => item.id === 'x')!;
  assert.ok(card.data.diagnostics.length > 0);
  assert.equal(card.data.hiddenDependencies, 1);
});

test('an empty scope renders an explicit empty frame', async t => {
  const tasks = [task('root', null), task('a', 'root')];
  const view = await mount(t, { tasks, ready: [], onSelect() {}, state: state(tasks), initialScope: 'a' });
  const frames = flow(view).frames;
  assert.deepEqual(frames.map(frame => frame.id), ['graph-frame:a']);
  assert.equal(frames[0]!.data.empty, true);
  assert.ok(text(view.root.findByProps({ className: 'taskmd-graph-shell' })).includes('没有符合筛选的直接子任务'));
});

test('the graph ships its own styles and imports no DSH package', async () => {
  assert.ok(graphStyles.includes('.taskmd-graph-card'));
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/ui/task-graph.tsx', import.meta.url), 'utf8'));
  assert.ok(!source.includes('@deepseek-ai/'), 'UI must not import DSH packages');
  assert.ok(!source.includes("from './styles.js'"), 'graph styles must not edit the shared stylesheet');
});

test('a removed scope falls back to the root frame instead of an empty canvas', async t => {
  const tasks = [task('root', null), task('a', 'root'), task('x', 'a')];
  const view = await mount(t, { tasks, ready: [], onSelect() {}, state: state(tasks), initialScope: 'a' });
  assert.deepEqual(flow(view).frames.map(frame => frame.id), ['graph-frame:a']);
  const withoutA = [tasks[0]!, tasks[2]!];
  await act(async () => { view.update(createElement(TaskGraph, { tasks: withoutA, ready: [], onSelect() {}, state: state(withoutA), initialScope: 'a' })); });
  assert.equal(flow(view).frames[0]!.id, 'graph-frame:root');
});
