import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraphLayout, graphBreadcrumbs, graphContext, graphFrameId, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, toggleGraphExpansion } from '../src/ui/graph-layout.js';
import { analyze } from '../src/core/graph.js';
import type { Task } from '../src/types.js';

let counter = 0;
function task(id: string, parent: string | null, overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    schema: 1, id, title: id.toUpperCase(), status: 'todo', parent, blocked_by: [],
    order: `a${String(counter).padStart(2, '0')}`, repo: null, assets: [], archived: false, body: '',
    ...overrides,
  };
}
const ids = (frame: { nodes: { task: Task }[] }) => frame.nodes.map(node => node.task.id);
const frameOf = (layout: ReturnType<typeof buildGraphLayout>, parent: string | null) =>
  layout.frames.find(frame => frame.parent === parent);

test('root tasks live in the virtual root frame; their children get their own frame', () => {
  const tasks = [
    task('root', null, { order: 'a0' }),
    task('a', 'root', { order: 'a0' }),
    task('b', 'root', { order: 'a1', blocked_by: ['a'] }),
    task('x', 'a', { order: 'a0' }),
    task('y', 'a', { order: 'a1' }),
  ];
  const rootFrame = frameOf(buildGraphLayout(tasks), null)!;
  assert.deepEqual(ids(rootFrame), ['root']);
  const layout = buildGraphLayout(tasks, { scope: 'root', expanded: new Set(['a']) });
  assert.deepEqual(ids(frameOf(layout, 'root')!).sort(), ['a', 'b']);
  assert.deepEqual(ids(frameOf(layout, 'a')!), ['x', 'y']);
  // Siblings of different parents never share a frame.
  for (const frame of layout.frames) assert.ok(new Set(frame.nodes.map(node => node.task.parent)).size <= 1);
  // A dependency never crosses a frame boundary.
  for (const frame of layout.frames) {
    const local = new Set(ids(frame));
    for (const edge of frame.dependencies) assert.ok(local.has(edge.source) && local.has(edge.target));
  }
});

test('collapsed descendants are not laid out until their parent is expanded', () => {
  const tasks = [task('root', null), task('a', 'root'), task('x', 'a')];
  const collapsed = buildGraphLayout(tasks, { scope: null });
  assert.deepEqual(collapsed.frames.map(frame => frame.parent), [null]);
  const expanded = buildGraphLayout(tasks, { scope: null, expanded: new Set(['root', 'a']) });
  assert.deepEqual(expanded.frames.map(frame => frame.parent), [null, 'root', 'a']);
  // One dashed guide per expanded parent, pointing at the frame, never at each child.
  assert.deepEqual(expanded.guides, [
    { source: 'root', target: graphFrameId('root') },
    { source: 'a', target: graphFrameId('a') },
  ]);
});

test('a chain and two islands stay separate: no invented edges, no shared layout', () => {
  const tasks = [
    task('root', null, { order: 'a0' }),
    task('a', 'root', { order: 'a0' }),
    task('b', 'root', { order: 'a1', blocked_by: ['a'] }),
    task('c', 'root', { order: 'a2' }),
    task('d', 'root', { order: 'a3' }),
  ];
  const frame = frameOf(buildGraphLayout(tasks, { scope: 'root' }), 'root')!;
  assert.deepEqual(frame.dependencies, [{ source: 'a', target: 'b' }]);
  const components = new Map(frame.nodes.map(node => [node.task.id, node.component]));
  assert.equal(components.get('a'), components.get('b'));
  assert.notEqual(components.get('c'), components.get('a'));
  assert.notEqual(components.get('d'), components.get('c'));
  // Each island occupies its own box, so nothing overlaps.
  const boxes = frame.nodes.map(node => ({ id: node.task.id, ...node.position }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const left = boxes[i]!, right = boxes[j]!;
    const overlapX = left.x < right.x + GRAPH_NODE_WIDTH && right.x < left.x + GRAPH_NODE_WIDTH;
    const overlapY = left.y < right.y + GRAPH_NODE_HEIGHT && right.y < left.y + GRAPH_NODE_HEIGHT;
    assert.ok(!(overlapX && overlapY), `${left.id} overlaps ${right.id}`);
  }
});

test('island order follows task order, not the input array', () => {
  const ordered = [
    task('root', null, { order: 'a0' }),
    task('a', 'root', { order: 'a0' }),
    task('b', 'root', { order: 'a1' }),
    task('c', 'root', { order: 'a2' }),
  ];
  const positions = (layout: ReturnType<typeof buildGraphLayout>) =>
    Object.fromEntries(frameOf(layout, 'root')!.nodes.map(node => [node.task.id, node.position]));
  const first = buildGraphLayout(ordered, { scope: 'root' });
  const shuffled = buildGraphLayout([ordered[3]!, ordered[0]!, ordered[2]!, ordered[1]!], { scope: 'root' });
  assert.deepEqual(positions(shuffled), positions(first));
  assert.deepEqual(ids(frameOf(first, 'root')!), ['a', 'b', 'c']);
});

test('dependency edges point from predecessor to successor', () => {
  const tasks = [task('root', null), task('a', 'root'), task('b', 'root', { blocked_by: ['a'] })];
  assert.deepEqual(frameOf(buildGraphLayout(tasks, { scope: 'root' }), 'root')!.dependencies,
    [{ source: 'a', target: 'b' }]);
});

test('a parent-child edge never enters the dependency layout', () => {
  const tasks = [task('root', null), task('a', 'root'), task('x', 'a')];
  const layout = buildGraphLayout(tasks, { scope: 'root', expanded: new Set(['a']) });
  for (const frame of layout.frames) {
    for (const edge of frame.dependencies) assert.notEqual(edge.target, 'x');
  }
  assert.deepEqual(frameOf(layout, 'root')!.dependencies, []);
  assert.deepEqual(frameOf(layout, 'a')!.dependencies, []);
});

test('collapsing a parent drops every deeper expansion', () => {
  const tasks = [task('root', null), task('a', 'root'), task('x', 'a'), task('y', 'x')];
  const deep = toggleGraphExpansion(tasks, toggleGraphExpansion(tasks, new Set(), 'a'), 'x');
  assert.deepEqual([...deep].sort(), ['a', 'x']);
  assert.deepEqual([...toggleGraphExpansion(tasks, deep, 'a')], []);
});

test('breadcrumbs walk real parents and stop on a cycle', () => {
  const tasks = [task('root', null), task('a', 'root'), task('b', 'a')];
  assert.deepEqual(graphBreadcrumbs(tasks, 'b').map(item => item.id), ['root', 'a', 'b']);
  const cycle = [task('c1', 'c2'), task('c2', 'c1')];
  assert.deepEqual(graphBreadcrumbs(cycle, 'c1').map(item => item.id), ['c2', 'c1']);
});

test('filtered tasks keep their ancestors as context without changing parents', () => {
  const tasks = [task('root', null), task('a', 'root'), task('x', 'a')];
  const filtered = [tasks[2]!];
  assert.deepEqual(graphContext(filtered, tasks).map(item => item.id), ['root', 'a', 'x']);
  // The root frame shows ancestors, not the filtered leaf: only `root` is a root task.
  const rootFrame = buildGraphLayout(filtered, { allTasks: tasks, scope: null }).frames[0]!;
  assert.deepEqual(ids(rootFrame), ['root']);
  assert.ok(rootFrame.nodes[0]!.context);
  // Navigating to the filtered leaf's parent surfaces it with its real parent intact.
  const layout = buildGraphLayout(filtered, { allTasks: tasks, scope: 'a' });
  const node = frameOf(layout, 'a')!.nodes.find(item => item.task.id === 'x')!;
  assert.equal(node.context, false);
  assert.equal(node.task.parent, 'a');
  assert.deepEqual(graphContext(filtered, tasks).map(item => item.id), ['root', 'a', 'x']);
});

test('a cross-parent dependency is diagnosed, not silently turned into an island', () => {
  const tasks = [
    task('root', null),
    task('a', 'root'),
    task('b', 'root'),
    task('x', 'a', { blocked_by: ['b'] }),
  ];
  const layout = buildGraphLayout(tasks, { scope: 'a' });
  const frame = frameOf(layout, 'a')!;
  assert.deepEqual(frame.dependencies, []);
  // No cross-frame solid edge is invented to "keep" the relation visible.
  for (const other of layout.frames) for (const edge of other.dependencies) assert.notEqual(edge.target, 'x');
  const diagnostics = layout.diagnostics.filter(item => item.taskId === 'x');
  assert.equal(diagnostics.length, 1, 'one problem, one diagnostic');
  assert.equal(diagnostics[0]!.severity, 'error');
  assert.match(diagnostics[0]!.message, /b/);
  assert.match(diagnostics[0]!.message, /x/);
});

test('a stale diagnostic snapshot still yields a graph-level cross-parent finding', () => {
  const tasks = [task('root', null), task('a', 'root'), task('b', 'root'), task('x', 'a', { blocked_by: ['b'] })];
  const layout = buildGraphLayout(tasks, { scope: 'a', diagnostics: [] });
  const diagnostic = layout.diagnostics.find(item => item.taskId === 'x');
  assert.ok(diagnostic);
  assert.equal(diagnostic!.code, 'CROSS_PARENT_DEPENDENCY');
  assert.match(diagnostic!.message, /B/);
  assert.match(diagnostic!.message, /X/);
});

test('a fresh core snapshot is not duplicated by the graph fallback', () => {
  const tasks = [task('root', null), task('a', 'root'), task('b', 'root'), task('x', 'a', { blocked_by: ['b'] })];
  const layout = buildGraphLayout(tasks, { scope: 'a', diagnostics: analyze(tasks).diagnostics });
  const crossParent = layout.diagnostics.filter(item => item.taskId === 'x'
    && (item.code === 'CROSS_PARENT_DEPENDENCY' || item.code === 'DEPENDENCY_SCOPE'));
  assert.equal(crossParent.length, 1);
});

test('an empty scope still renders a frame with a heading', () => {
  const tasks = [task('root', null), task('a', 'root')];
  const frame = frameOf(buildGraphLayout(tasks, { scope: 'a' }), 'a')!;
  assert.deepEqual(frame.nodes, []);
  assert.ok(frame.height > 0 && frame.width > 0);
});

test('expanded frames are placed beside their parent frame without overlap', () => {
  const tasks = [task('root', null), task('a', 'root'), task('b', 'root'), task('x', 'a'), task('y', 'b')];
  const layout = buildGraphLayout(tasks, { scope: 'root', expanded: new Set(['a', 'b']) });
  const root = frameOf(layout, 'root')!;
  const a = frameOf(layout, 'a')!;
  const b = frameOf(layout, 'b')!;
  for (const child of [a, b]) {
    assert.ok(child.position.x >= root.position.x + root.width, 'child frame sits right of the parent frame');
  }
  // Sibling frames in the same column never overlap.
  assert.ok(a.position.y + a.height <= b.position.y || b.position.y + b.height <= a.position.y);
  assert.ok(a.position.y + a.height <= b.position.y || b.position.y + b.height <= a.position.y);
});

test('a cycle in the parent chain still produces browsable frames', () => {
  const tasks = [task('root', null), task('c1', 'c2'), task('c2', 'c1')];
  const layout = buildGraphLayout(tasks);
  assert.ok(layout.frames.length >= 1);
  assert.deepEqual(ids(frameOf(layout, null)!), ['root']);
});
