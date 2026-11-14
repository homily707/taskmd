import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import type { Operation, State, Task } from '../types.js';
import type { TaskGraphPort } from './port.js';
import { compareTasks, failure, progress, statusLabels } from './shared.js';
import { chipLabel, type TaskAgentView } from './agent-status.js';
import { indentOperations, moveOperations, outlineRows, type Placement } from './outline-model.js';
import { isStringList, useStored } from './view-state.js';

export function TaskOutline({ tasks, state, selected, port, onSelect, onChanged, agent, reveal }: {
  tasks: Task[]; state: State; selected?: string; port: TaskGraphPort; onSelect(id: string): void; onChanged(): Promise<void>;
  /** Rolled-up agent views per task id; `undefined` hides every agent chip. */
  agent?: Map<string, TaskAgentView>;
  /** A pill jump: unfold the target's ancestors so the selection is visible. */
  reveal?: { id: string; nonce: number };
}) {
  // Folded parents stay folded after the panel closes; ids of removed tasks are ignored by `outlineRows`.
  const [collapsedIds, setCollapsedIds] = useStored<string[]>('collapsed', [], isStringList);
  const collapsed = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const fold = (id: string) => setCollapsedIds(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  // A jump from the header pills must land on a visible row, so every ancestor
  // of the target unfolds once per nonce. Unrelated folds stay untouched.
  useEffect(() => {
    if (!reveal) return;
    setCollapsedIds(previous => {
      const ancestors = new Set<string>();
      let parent = state.tasks.find(task => task.id === reveal.id)?.parent;
      while (parent && !ancestors.has(parent)) {
        ancestors.add(parent);
        parent = state.tasks.find(task => task.id === parent)?.parent;
      }
      const next = previous.filter(id => !ancestors.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [reveal?.nonce, reveal?.id, state.tasks, setCollapsedIds]);
  // A restored selection may sit far down the tree; reveal it once the rows exist.
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, collapsedIds]);
  const [adding, setAdding] = useState<string | null | undefined>();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState<string>();
  const [drop, setDrop] = useState<{ id: string; placement: Placement }>();
  const transact = async (operations: Operation[], created = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await port.apply({ requestId: crypto.randomUUID(), baseRevision: state.revision, operations });
      if (created) { setAdding(undefined); setTitle(''); onSelect(result.ids.new!); }
      await onChanged();
    } catch (error) { setError(`${failure(error)}\n操作未提交，已刷新任务，请检查后重新操作。`); await onChanged(); }
    finally { setBusy(false); }
  };
  const move = (build: () => Operation[]) => { try { void transact(build()); } catch (error) { setError(failure(error)); } };
  const addForm = (parent: string | null) => {
    const parentTask = state.tasks.find(t => t.id === parent);
    return <form className="taskmd-inline-create" onSubmit={event => {
      event.preventDefault();
      if (!title.trim()) return;
      const operations: Operation[] = [];
      operations.push({ op: 'create', key: 'new', task: { title: title.trim(), parent, repo: parentTask?.repo || null } });
      void transact(operations, true);
    }}>
      <input autoFocus aria-label="新任务标题" placeholder={parent ? '子任务标题' : '根任务标题'} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
      <div className="taskmd-toolbar"><button disabled={busy || !title.trim()}>添加</button><button type="button" disabled={busy} onClick={() => setAdding(undefined)}>取消</button></div>
    </form>;
  };
  const placementAt = (event: DragEvent<HTMLElement>): Placement => {
    const rect = event.currentTarget.getBoundingClientRect(), ratio = (event.clientY - rect.top) / rect.height;
    return ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'inside';
  };
  return <div className="taskmd-outline">
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    <ul className="taskmd-tree" aria-label="任务大纲" ref={list}>{outlineRows(tasks, collapsed).map(({ task, depth }) => {
      const count = progress(state.tasks, task.id), siblings = state.tasks.filter(t => t.parent === task.parent && !t.archived).sort(compareTasks);
      const index = siblings.findIndex(t => t.id === task.id);
      const agentView = agent?.get(task.id);
      const agentChip = agentView ? chipLabel(agentView, agentView.statuses.length) : undefined;
      const progressPct = count.total ? Math.round(count.terminal / count.total * 100) : 0;
      return <li key={task.id}>
        <div className={`taskmd-outline-row${selected === task.id ? ' is-selected' : ''}${drop?.id === task.id ? ` taskmd-drop-${drop.placement}` : ''}`}
          style={{ paddingInlineStart: Math.min(depth, 12) * 14 }} title="拖动行上/下缘排序，拖到行中间设为子任务；选中任务标题后 Tab / Shift+Tab 调整层级"
          draggable={!busy && !task.archived} onDragStart={event => { setDragging(task.id); event.dataTransfer.setData('text/taskmd-id', task.id); event.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={() => { setDragging(undefined); setDrop(undefined); }}
          onDragOver={event => { if (dragging && dragging !== task.id) { event.preventDefault(); setDrop({ id: task.id, placement: placementAt(event) }); } }}
          onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('text/taskmd-id'); const placement = placementAt(event); setDrop(undefined); setDragging(undefined); if (id) move(() => moveOperations(state.tasks, id, task.id, placement)); }}>
          <button className="taskmd-fold" disabled={!count.total} aria-label={`${collapsed.has(task.id) ? '展开' : '折叠'} ${task.title}`} aria-expanded={count.total ? !collapsed.has(task.id) : undefined}
            onClick={() => fold(task.id)}>{count.total ? collapsed.has(task.id) ? '▸' : '▾' : '·'}</button>
          <span className={`taskmd-status-dot is-${task.status}`} role="img" aria-label={statusLabels[task.status]} />
          <button className={`taskmd-outline-label${task.status === 'done' ? ' is-done' : ''}`} aria-current={selected === task.id ? 'true' : undefined} onClick={() => onSelect(task.id)}
            onKeyDown={event => { if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); move(() => indentOperations(state.tasks, task.id, event.shiftKey)); } }}>
            <strong>{task.title}</strong>
          </button>
          <span className="taskmd-row-meta">
            {agentChip && <span className={`taskmd-agent-chip is-${agentView!.level}`}>{agentChip}</span>}
            {count.total > 0 && <span className="taskmd-progress" title={`子任务 ${count.done}/${count.total} 完成${count.canceled > 0 ? ` · ${count.canceled} 取消` : ''}`}>
              <i style={{ '--p': `${progressPct}%` } as CSSProperties} /><span>{count.done}/{count.total}</span></span>}
            {task.repo && <span className="taskmd-tag">{task.repo}</span>}
            {task.archived && <span className="taskmd-tag">已归档</span>}
          </span>
          <details className="taskmd-row-menu"><summary aria-label={`操作 ${task.title}`}>···</summary><div>
            <button disabled={busy || task.archived} onClick={() => { setAdding(task.id); setTitle(''); setCollapsedIds(previous => previous.filter(item => item !== task.id)); }}>添加子任务</button>
            <button disabled={busy || index < 1} onClick={() => move(() => moveOperations(state.tasks, task.id, siblings[index - 1]!.id, 'before'))}>上移</button>
            <button disabled={busy || index === siblings.length - 1} onClick={() => move(() => moveOperations(state.tasks, task.id, siblings[index + 1]!.id, 'after'))}>下移</button>
            <button disabled={busy || index < 1} onClick={() => move(() => indentOperations(state.tasks, task.id, false))}>缩进</button>
            <button disabled={busy || !task.parent} onClick={() => move(() => indentOperations(state.tasks, task.id, true))}>反缩进</button>
          </div></details>
        </div>
        {adding === task.id && addForm(task.id)}
      </li>;
    })}</ul>
    {tasks.length === 0 && <p className="taskmd-muted">没有符合条件的任务。</p>}
    {adding === null ? addForm(null) : <button className="taskmd-add-root" disabled={busy} onClick={() => { setAdding(null); setTitle(''); }}>＋ 新建根任务</button>}
  </div>;
}
