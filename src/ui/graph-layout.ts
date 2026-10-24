import dagre from 'dagre';
import { analyze } from '../core/graph.js';
import type { Diagnostic, Task } from '../types.js';

export const GRAPH_NODE_WIDTH = 232;
export const GRAPH_NODE_HEIGHT = 132;
/** Inner padding and gap between sibling boxes inside one frame. */
const GAP = 28;
/** Room for the frame heading above its first row of task cards. */
const HEADER = 104;
/** Soft wrap width for islands and disconnected components inside one frame. */
const SHELF = 720;
const compare = (a: Task, b: Task) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export const graphFrameId = (parent: string | null) => `graph-frame:${parent ?? 'root'}`;
export interface GraphPoint { x: number; y: number }
export interface GraphTaskNode { task: Task; position: GraphPoint; component: number; context: boolean }
export interface GraphDependency { source: string; target: string }
export interface GraphFrame {
  id: string; parent: string | null; depth: number; position: GraphPoint;
  width: number; height: number; nodes: GraphTaskNode[]; dependencies: GraphDependency[];
}
export interface GraphLayout {
  frames: GraphFrame[];
  /** One dashed guide per expanded parent: parent node -> that parent's frame. */
  guides: { source: string; target: string }[];
  diagnostics: Diagnostic[];
}

/** Filtering keeps ancestor context, but never changes a task's direct parent. */
export function graphContext(tasks: Task[], allTasks: Task[]): Task[] {
  const byId = new Map(allTasks.map(task => [task.id, task]));
  const included = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    const visited = new Set([task.id]);
    let parent = task.parent;
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) break;
      included.set(parent, ancestor);
      parent = ancestor.parent;
    }
  }
  return [...included.values()].sort(compare);
}

export function graphBreadcrumbs(tasks: Task[], scope: string | null): Task[] {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const result: Task[] = [];
  const seen = new Set<string>();
  while (scope && !seen.has(scope)) {
    seen.add(scope);
    const task = byId.get(scope);
    if (!task) break;
    result.unshift(task);
    scope = task.parent;
  }
  return result;
}

/** Collapsing also resets deeper expansions so reopening is one level at a time. */
export function toggleGraphExpansion(tasks: Task[], expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (!next.has(id)) { next.add(id); return next; }
  const pending = [id];
  const seen = new Set<string>();
  const children = new Map<string, string[]>();
  for (const task of tasks) if (task.parent) children.set(task.parent, [...(children.get(task.parent) ?? []), task.id]);
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current); next.delete(current);
    pending.push(...(children.get(current) ?? []));
  }
  return next;
}

/**
 * Lays out one frame: the direct children of `parent`.
 *
 * Only dependencies whose both ends are direct siblings become solid edges; a
 * parent-child edge is grouping, never ordering, so it stays out of dagre.
 */
function layoutSiblings(parent: string | null, tasks: Task[], visible: Set<string>, depth: number): GraphFrame {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const dependencies = tasks.flatMap(task => [...new Set(task.blocked_by)]
    .filter(id => id !== task.id && byId.has(id))
    .map(source => ({ source, target: task.id })));
  const neighbors = new Map(tasks.map(task => [task.id, new Set<string>()]));
  for (const edge of dependencies) { neighbors.get(edge.source)!.add(edge.target); neighbors.get(edge.target)!.add(edge.source); }
  const components: Task[][] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    const pending = [task.id], component: Task[] = [];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id); component.push(byId.get(id)!);
      pending.push(...neighbors.get(id)!);
    }
    components.push(component.sort(compare));
  }
  const nodes: GraphTaskNode[] = [];
  let x = GAP, y = HEADER, rowHeight = 0, width = 320;
  for (const [index, component] of components.entries()) {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'LR', nodesep: GAP, ranksep: 64 });
    graph.setDefaultEdgeLabel(() => ({}));
    const ids = new Set(component.map(task => task.id));
    for (const task of component) graph.setNode(task.id, { width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT });
    for (const edge of dependencies) if (ids.has(edge.source)) graph.setEdge(edge.source, edge.target);
    dagre.layout(graph);
    const size = graph.graph();
    const componentWidth = size.width || GRAPH_NODE_WIDTH, componentHeight = size.height || GRAPH_NODE_HEIGHT;
    // Shelf packing gives islands real space without inventing dependency edges.
    if (x > GAP && x + componentWidth + GAP > SHELF) { x = GAP; y += rowHeight + GAP; rowHeight = 0; }
    for (const task of component) {
      const point = graph.node(task.id);
      nodes.push({ task, component: index, context: !visible.has(task.id),
        position: { x: x + point.x - GRAPH_NODE_WIDTH / 2, y: y + point.y - GRAPH_NODE_HEIGHT / 2 } });
    }
    width = Math.max(width, x + componentWidth + GAP);
    rowHeight = Math.max(rowHeight, componentHeight);
    x += componentWidth + GAP;
  }
  return { id: graphFrameId(parent), parent, depth, position: { x: 0, y: 0 }, width,
    height: tasks.length ? y + rowHeight + GAP : HEADER + 72, nodes, dependencies };
}

export function buildGraphLayout(tasks: Task[], options: {
  allTasks?: Task[]; scope?: string | null; expanded?: ReadonlySet<string>; diagnostics?: Diagnostic[];
} = {}): GraphLayout {
  const allTasks = options.allTasks ?? tasks;
  const scope = options.scope ?? null;
  const byId = new Map(allTasks.map(task => [task.id, task]));
  const visible = new Set(tasks.map(task => task.id));
  const context = graphContext(tasks, allTasks);
  const children = new Map<string | null, Task[]>();
  for (const task of context) children.set(task.parent, [...(children.get(task.parent) ?? []), task]);
  const diagnostics = [...(options.diagnostics ?? analyze(allTasks).diagnostics)];
  // A cross-parent dependency is illegal data, not an island: say so instead of
  // dropping the edge silently.
  for (const task of allTasks) for (const dependency of [...new Set(task.blocked_by)]) {
    const source = byId.get(dependency);
    if (!source || source.parent === task.parent) continue;
    if (diagnostics.some(item => item.taskId === task.id && (item.code === 'CROSS_PARENT_DEPENDENCY' || item.code === 'DEPENDENCY_SCOPE'))) continue;
    diagnostics.push({ taskId: task.id, code: 'CROSS_PARENT_DEPENDENCY', severity: 'error',
      message: `跨父依赖：${task.title} 依赖 ${source.title}；依赖只能连接同一父任务的直接子任务。` });
  }
  const pending = [{ parent: scope, depth: 0 }];
  if (scope === null) {
    for (const parent of children.keys()) if (parent && !byId.has(parent)) pending.push({ parent, depth: 0 });
    // Corrupt parent cycles have no root. Surface them in separate, diagnosed frames.
    const reachable = new Set(context.filter(task => !task.parent || !byId.has(task.parent)).map(task => task.id));
    const queue = [...reachable];
    for (let index = 0; index < queue.length; index++) for (const child of children.get(queue[index]!) ?? []) {
      if (!reachable.has(child.id)) { reachable.add(child.id); queue.push(child.id); }
    }
    for (const task of context) if (!reachable.has(task.id) && task.parent) pending.push({ parent: task.parent, depth: 0 });
  }
  const frames: GraphFrame[] = [], guides: GraphLayout['guides'] = [];
  const laidOut = new Set<string | null>();
  for (let index = 0; index < pending.length; index++) {
    const { parent, depth } = pending[index]!;
    if (laidOut.has(parent)) continue;
    laidOut.add(parent);
    const frame = layoutSiblings(parent, children.get(parent) ?? [], visible, depth);
    frames.push(frame);
    for (const node of frame.nodes) if (options.expanded?.has(node.task.id) && !laidOut.has(node.task.id)) {
      pending.push({ parent: node.task.id, depth: depth + 1 });
      guides.push({ source: node.task.id, target: graphFrameId(node.task.id) });
    }
  }
  let columnX = 0;
  const deepest = Math.max(0, ...frames.map(frame => frame.depth));
  for (let depth = 0; depth <= deepest; depth++) {
    const column = frames.filter(frame => frame.depth === depth);
    let y = 0;
    for (const frame of column) { frame.position = { x: columnX, y }; y += frame.height + 64; }
    columnX += Math.max(0, ...column.map(frame => frame.width)) + 120;
  }
  return { frames, guides, diagnostics };
}
