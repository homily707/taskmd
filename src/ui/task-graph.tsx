import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import flowStyles from '@xyflow/react/dist/style.css';
import type { State, Task } from '../types.js';
import { executionBlockers } from '../core/graph.js';
import { statusLabels } from './shared.js';
import { buildGraphLayout, graphBreadcrumbs, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, toggleGraphExpansion } from './graph-layout.js';

/**
 * Graph-local presentation only. `styles.ts` belongs to the page shell and is
 * shared by every view, so the graph ships the rules it owns.
 */
export const graphStyles = `
.taskmd-graph-shell{display:flex;flex-direction:column;gap:8px;min-width:0}
.taskmd-graph-nav{display:flex;flex-wrap:wrap;align-items:center;gap:2px;font-size:13px}
.taskmd-graph-nav button{border:1px solid transparent;padding:2px 6px;border-radius:6px}
.taskmd-graph-nav button[aria-current=page]{border-color:var(--tm-accent,#557ee8);background:color-mix(in srgb,var(--tm-accent,#557ee8) 12%,transparent)}
.taskmd-graph-legend{display:flex;flex-wrap:wrap;gap:14px;margin:0;font-size:12px;opacity:.75}
.taskmd-graph-diagnostics{margin:0;font-size:12px}
.taskmd-graph-diagnostics ul{padding-left:20px;margin:6px 0 0}
.taskmd-graph-diagnostics li{overflow-wrap:anywhere}
.taskmd-graph-canvas{position:relative;height:560px;min-height:340px;border:1px solid var(--tm-border,color-mix(in srgb,currentColor 18%,transparent));border-radius:8px;overflow:hidden}
.taskmd-graph-shell .react-flow__node{padding:0;border:0;background:transparent;box-shadow:none;width:auto}
.taskmd-graph-shell .react-flow__node.taskmd-graph-frame{background:color-mix(in srgb,currentColor 4%,transparent);border:1px dashed color-mix(in srgb,currentColor 30%,transparent);border-radius:10px;z-index:0}
.taskmd-graph-frame-heading{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px dashed color-mix(in srgb,currentColor 24%,transparent)}
.taskmd-graph-frame-heading strong{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.taskmd-graph-frame-heading small{font-size:12px;opacity:.8;overflow-wrap:anywhere}
.taskmd-graph-empty{margin:12px;font-size:12px;opacity:.75}
.taskmd-graph-card{display:flex;flex-direction:column;gap:4px;height:100%;padding:10px;border:1px solid var(--tm-border,color-mix(in srgb,currentColor 18%,transparent));border-radius:8px;background:Canvas;color:CanvasText}
.taskmd-graph-card.is-selected{border-color:var(--tm-accent,#557ee8);box-shadow:0 0 0 1px var(--tm-accent,#557ee8)}
.taskmd-graph-card.is-done{border:2px solid #2e9e5b;padding:9px;background:color-mix(in srgb,#2e9e5b 10%,Canvas)}
.taskmd-graph-card.is-invalid{border-color:#dc5555}
.taskmd-graph-select{display:flex;flex-direction:column;gap:2px;text-align:left;border:0;padding:0;background:transparent;min-width:0;cursor:pointer}
.taskmd-graph-select strong{font-weight:600;font-size:13px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.taskmd-graph-select span{font-size:12px;opacity:.75}
.taskmd-graph-select .taskmd-graph-done-mark{color:#2e9e5b;font-size:inherit;font-weight:700;opacity:1}
.taskmd-graph-note{font-size:11px;opacity:.7;min-height:14px;overflow-wrap:anywhere}
.taskmd-graph-actions{display:flex;flex-wrap:wrap;gap:4px;margin-top:auto}
.taskmd-graph-actions button{font-size:11px;padding:2px 6px;border:1px solid var(--tm-border,color-mix(in srgb,currentColor 18%,transparent));border-radius:6px;background:transparent;cursor:pointer}
.taskmd-graph-actions button:hover{border-color:var(--tm-accent,#557ee8)}
@media(max-width:700px){.taskmd-graph-canvas{height:400px}}
`;

export interface TaskGraphProps {
  tasks: Task[];
  ready: string[];
  selected?: string;
  onSelect(id: string): void;
  /** Full state; required when `tasks` is a filtered subset. */
  state?: State;
  /** Direct parent whose children initially fill the graph; null is the virtual root. */
  initialScope?: string | null;
}

type TaskNode = Node<{
  task: Task; ready: boolean; context: boolean; childCount: number; expanded: boolean;
  diagnostics: string[]; hiddenDependencies: number; waiting: string;
  onSelect(id: string): void; onToggle(id: string): void; onEnter(id: string): void;
}, 'task'>;
type FrameNode = Node<{ title: string; waiting: string; empty: boolean; parent: string | null; onEnter(id: string): void }, 'frame'>;

function TaskCard({ data, selected }: NodeProps<TaskNode>) {
  const { task } = data;
  return <div className={`taskmd-graph-card${task.status === 'done' ? ' is-done' : ''}${selected ? ' is-selected' : ''}${data.diagnostics.length ? ' is-invalid' : ''}`}>
    <Handle type="target" position={Position.Left} />
    <button className="taskmd-graph-select nodrag" onClick={() => data.onSelect(task.id)} aria-current={selected ? 'true' : undefined} title={task.title}>
      <strong>{task.status === 'done' && <span className="taskmd-graph-done-mark" aria-hidden="true">✓ </span>}{task.title}</strong><span>{statusLabels[task.status]}{task.archived ? ' · 已归档' : ''}</span>
    </button>
    <small className="taskmd-graph-note" title={data.diagnostics.join('\n')}>
      {data.diagnostics.length ? '⚠ 关系异常，见图诊断'
        : data.hiddenDependencies ? `含 ${data.hiddenDependencies} 个当前图外的前置任务`
        : data.ready ? '可开始'
        : data.waiting || (data.context ? '上层任务（筛选上下文）' : ' ')}
    </small>
    {!!data.childCount && <div className="taskmd-graph-actions">
      <button className="nodrag" aria-expanded={data.expanded} aria-label={`${data.expanded ? '收起' : '展开'} ${task.title} 的子图`} onClick={() => data.onToggle(task.id)}>{data.expanded ? '收起' : '展开'} ({data.childCount})</button>
      <button className="nodrag" onClick={() => data.onEnter(task.id)} aria-label={`进入 ${task.title} 的子图`}>进入子图</button>
    </div>}
    <Handle type="source" position={Position.Right} />
  </div>;
}

function FrameCard({ data }: NodeProps<FrameNode>) {
  return <>
    <Handle type="target" position={Position.Left} style={{ top: 27 }} />
    <div className="taskmd-graph-frame-heading">
      <strong title={data.title}>{data.title}</strong>
      {data.parent && <button className="nodrag" onClick={() => data.onEnter(data.parent!)}>进入</button>}
      <small title={data.waiting}>{data.waiting || '同父任务 · 实线箭头表示直接依赖'}</small>
    </div>
    {data.empty && <p className="taskmd-graph-empty">当前范围没有符合筛选的直接子任务。</p>}
  </>;
}
const nodeTypes = { task: TaskCard, frame: FrameCard };

/** Re-fit after scope, expansion or layout changes; plain `fitView` only runs on mount. */
function FitGraph({ signature }: { signature: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return;
    const frame = requestAnimationFrame(() => { void fitView({ padding: 0.15, maxZoom: 1 }); });
    return () => cancelAnimationFrame(frame);
  }, [signature, fitView]);
  return null;
}

export function TaskGraph({ tasks, ready, selected, onSelect, state, initialScope }: TaskGraphProps) {
  const allTasks = state?.tasks ?? tasks;
  const byId = useMemo(() => new Map(allTasks.map(task => [task.id, task])), [allTasks]);
  const [scope, setScope] = useState<string | null>(() => initialScope !== undefined
    ? initialScope
    : allTasks.find(task => task.id === selected)?.parent ?? null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const layout = useMemo(() => buildGraphLayout(tasks, { allTasks, scope, expanded, diagnostics: state?.diagnostics }),
    [tasks, allTasks, scope, expanded, state?.diagnostics]);
  const visibleIds = useMemo(() => new Set(layout.frames.flatMap(frame => frame.nodes.map(node => node.task.id))), [layout]);
  const enter = (id: string | null) => { setScope(id); setExpanded(new Set<string>()); };
  const toggle = (id: string) => setExpanded(previous => toggleGraphExpansion(allTasks, previous, id));

  // Keep the frame aligned with the details selection without fighting user
  // navigation: only a *changed* selection pulls the scope to its parent.
  const previousSelected = useRef<string | undefined>(selected);
  useEffect(() => {
    if (selected === previousSelected.current) return;
    previousSelected.current = selected;
    if (!selected || !byId.has(selected)) return;
    if (visibleIds.has(selected)) return;
    enter(byId.get(selected)!.parent);
  }, [selected, byId, visibleIds]);
  // An explicit `initialScope` is the caller's decision: follow later changes.
  const previousInitial = useRef(initialScope);
  useEffect(() => {
    if (initialScope === undefined || initialScope === previousInitial.current) return;
    previousInitial.current = initialScope;
    enter(initialScope);
  }, [initialScope]);
  // A removed or moved scope must not strand the graph on a missing frame.
  useEffect(() => {
    if (scope !== null && !byId.has(scope)) enter(null);
  }, [scope, byId]);

  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of allTasks) if (task.parent) counts.set(task.parent, (counts.get(task.parent) ?? 0) + 1);
    return counts;
  }, [allTasks]);
  const diagnosticsByTask = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const item of layout.diagnostics) if (item.taskId) grouped.set(item.taskId, [...(grouped.get(item.taskId) ?? []), item.message]);
    return grouped;
  }, [layout.diagnostics]);
  const readyIds = useMemo(() => new Set(ready), [ready]);
  /** Per-task "waiting" text; Ready stays a derived query, never a status. */
  const waitingByTask = useMemo(() => {
    const reasons = new Map<string, string>();
    for (const node of layout.frames.flatMap(frame => frame.nodes)) {
      if (node.task.status !== 'todo' || readyIds.has(node.task.id)) continue;
      const blockers = executionBlockers(allTasks, node.task.id);
      const text = [...new Set(blockers.map(blocker => blocker.dependencyId
        ? `等待 ${byId.get(blocker.dependencyId)?.title ?? blocker.dependencyId}` : blocker.message))].join('；');
      if (text) reasons.set(node.task.id, text);
    }
    return reasons;
  }, [layout.frames, allTasks, byId, readyIds]);
  const waitingByParent = useMemo(() => {
    const reasons = new Map<string, string>();
    for (const frame of layout.frames) {
      if (!frame.parent) continue;
      const blockers = executionBlockers(allTasks, frame.parent);
      reasons.set(frame.parent, [...new Set(blockers.map(blocker => blocker.dependencyId
        ? `等待 ${byId.get(blocker.dependencyId)?.title ?? blocker.dependencyId}` : blocker.message))].join('；'));
    }
    return reasons;
  }, [layout.frames, allTasks, byId]);

  const nodes: (TaskNode | FrameNode)[] = [];
  const edges: Edge[] = [];
  for (const frame of layout.frames) {
    nodes.push({ id: frame.id, type: 'frame', position: frame.position, selectable: false, draggable: false,
      connectable: false, focusable: false, className: 'taskmd-graph-frame', ariaLabel: frame.parent ? `${byId.get(frame.parent)?.title ?? frame.parent} 的子图` : '根任务图框',
      style: { width: frame.width, height: frame.height },
      data: { title: frame.parent ? `${byId.get(frame.parent)?.title ?? `缺失父任务 ${frame.parent}`} / 子任务` : '根任务',
        waiting: (frame.parent && waitingByParent.get(frame.parent)) || '', empty: frame.nodes.length === 0,
        parent: frame.parent, onEnter: enter } });
    const frameIds = new Set(frame.nodes.map(node => node.task.id));
    for (const node of frame.nodes) {
      nodes.push({ id: node.task.id, type: 'task', parentId: frame.id, extent: 'parent', position: node.position,
        style: { width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }, selected: node.task.id === selected,
        ariaLabel: `${node.task.title}（${statusLabels[node.task.status]}）`,
        data: { task: node.task, ready: readyIds.has(node.task.id), context: node.context,
          childCount: childCounts.get(node.task.id) ?? 0, expanded: expanded.has(node.task.id),
          diagnostics: diagnosticsByTask.get(node.task.id) ?? [],
          hiddenDependencies: node.task.blocked_by.filter(id => !frameIds.has(id)).length,
          waiting: waitingByTask.get(node.task.id) ?? '',
          onSelect, onToggle: toggle, onEnter: enter } });
    }
    // Solid arrows: direct sibling dependencies only, predecessor -> successor.
    for (const edge of frame.dependencies) edges.push({ id: `dependency:${edge.source}:${edge.target}`, ...edge,
      type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#557ee8', strokeWidth: 2 },
      ariaLabel: `${byId.get(edge.source)?.title} 是 ${byId.get(edge.target)?.title} 的前置任务` });
  }
  // One dashed guide per expanded parent: membership, never ordering.
  for (const guide of layout.guides) edges.push({ id: `children:${guide.source}`, ...guide, type: 'smoothstep',
    style: { stroke: '#8d94a1', strokeDasharray: '6 5', strokeWidth: 2 }, label: '子图',
    ariaLabel: `${byId.get(guide.source)?.title} 的子图归属，不表示依赖` });

  const breadcrumbs = graphBreadcrumbs(allTasks, scope);
  const signature = JSON.stringify(layout.frames.map(frame => [frame.id, frame.position, frame.width, frame.height,
    frame.nodes.map(node => [node.task.id, node.position])]));
  return <section className="taskmd-graph-shell" aria-label="任务关系图">
    <style>{flowStyles}{graphStyles}</style>
    <nav className="taskmd-graph-nav" aria-label="图范围面包屑">
      <button onClick={() => enter(null)} aria-current={scope === null ? 'page' : undefined}>根任务</button>
      {breadcrumbs.map(task => <span key={task.id}><span aria-hidden="true"> / </span>
        <button onClick={() => enter(task.id)} aria-current={scope === task.id ? 'page' : undefined}>{task.title}</button></span>)}
    </nav>
    <p className="taskmd-graph-legend"><span>实线 → 前置任务到后续任务</span><span>虚线 ⇢ 展开子图归属</span><span>孤岛没有依赖顺序</span></p>
    {!!layout.diagnostics.length && <details className="taskmd-graph-diagnostics" open>
      <summary>图诊断（{layout.diagnostics.length}）</summary>
      <ul>{layout.diagnostics.map((item, index) => <li key={`${item.code}:${item.taskId ?? ''}:${index}`}>
        {item.taskId && byId.has(item.taskId) && <button onClick={() => { onSelect(item.taskId!); enter(byId.get(item.taskId!)!.parent); }}>{byId.get(item.taskId)?.title}</button>}
        <span>{item.code}: {item.message}</span>
      </li>)}</ul>
    </details>}
    <div className="taskmd-graph-canvas">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ maxZoom: 1 }}
        nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} minZoom={0.1} maxZoom={2}
        onNodeClick={(_event, node) => { if (node.type === 'task') onSelect(node.id); }}
        ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大', 'controls.zoomOut.ariaLabel': '缩小', 'controls.fitView.ariaLabel': '显示全部' }}>
        <FitGraph signature={signature} /><Background /><Controls showInteractive={false} /><MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  </section>;
}
