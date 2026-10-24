import { useState, type DragEvent } from 'react';
import type { Operation, State, Task } from '../types.js';
import type { TaskGraphPort } from './port.js';
import { executionBlockers } from '../core/graph.js';
import { compareTasks, failure, progress, statusLabels } from './shared.js';
import { indentOperations, moveOperations, outlineRows, type Placement } from './outline-model.js';

export function TaskOutline({ tasks, state, selected, port, onSelect, onChanged }: {
  tasks: Task[]; state: State; selected?: string; port: TaskGraphPort; onSelect(id: string): void; onChanged(): Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [adding, setAdding] = useState<string | null | undefined>();
  const [title, setTitle] = useState('');
  const [reopen, setReopen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState<string>();
  const [drop, setDrop] = useState<{ id: string; placement: Placement }>();
  const transact = async (operations: Operation[], created = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await port.apply({ requestId: crypto.randomUUID(), baseRevision: state.revision, operations });
      if (created) { setAdding(undefined); setTitle(''); setReopen(false); onSelect(result.ids.new!); }
      await onChanged();
    } catch (error) { setError(`${failure(error)}\n操作未提交，已刷新任务，请检查后重新操作。`); await onChanged(); }
    finally { setBusy(false); }
  };
  const move = (build: () => Operation[]) => { try { void transact(build()); } catch (error) { setError(failure(error)); } };
  const addForm = (parent: string | null) => {
    const parentTask = state.tasks.find(t => t.id === parent);
    const ancestors: Task[] = []; let cursor = parentTask; const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) { seen.add(cursor.id); ancestors.push(cursor); cursor = state.tasks.find(t => t.id === cursor!.parent); }
    const terminal = ancestors.filter(t => t.status === 'done' || t.status === 'canceled');
    return <form className="taskmd-inline-create" onSubmit={event => {
      event.preventDefault();
      if (!title.trim() || (terminal.length > 0 && !reopen)) return;
      const operations: Operation[] = terminal.map(t => ({ op: 'patch', id: t.id, changes: { status: 'todo' } }));
      operations.push({ op: 'create', key: 'new', task: { title: title.trim(), parent, repo: parentTask?.repo || null } });
      void transact(operations, true);
    }}>
      <input autoFocus aria-label="新任务标题" placeholder={parent ? '子任务标题' : '根任务标题'} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
      {terminal.length > 0 && <label><input type="checkbox" checked={reopen} onChange={event => setReopen(event.target.checked)} />明确重新打开 {terminal.map(t => t.title).join('、')} 并添加子任务</label>}
      <div className="taskmd-toolbar"><button disabled={busy || !title.trim() || (terminal.length > 0 && !reopen)}>添加</button><button type="button" disabled={busy} onClick={() => setAdding(undefined)}>取消</button></div>
    </form>;
  };
  const placementAt = (event: DragEvent<HTMLElement>): Placement => {
    const rect = event.currentTarget.getBoundingClientRect(), ratio = (event.clientY - rect.top) / rect.height;
    return ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'inside';
  };
  return <div className="taskmd-outline">
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    <p className="taskmd-muted taskmd-outline-hint">拖动行上/下缘排序，拖到行中间设为子任务；选中任务标题后 Tab / Shift+Tab 调整层级。</p>
    <ul className="taskmd-tree" aria-label="任务大纲">{outlineRows(tasks, collapsed).map(({ task, depth }) => {
      const count = progress(state.tasks, task.id), siblings = state.tasks.filter(t => t.parent === task.parent && !t.archived).sort(compareTasks);
      const index = siblings.findIndex(t => t.id === task.id);
      const blockers = task.status === 'todo' ? executionBlockers(state.tasks, task.id) : [];
      const blockerText = blockers.length
        ? blockers[0]!.dependencyId
          ? `等待 ${(state.tasks.find(item => item.id === blockers[0]!.dependencyId) || { title: blockers[0]!.dependencyId }).title}`
          : blockers[0]!.message
        : '';
      return <li key={task.id}>
        <div className={`taskmd-outline-row ${drop?.id === task.id ? `taskmd-drop-${drop.placement}` : ''}`} style={{ paddingInlineStart: Math.min(depth, 12) * 16 }}
          draggable={!busy && !task.archived} onDragStart={event => { setDragging(task.id); event.dataTransfer.setData('text/taskmd-id', task.id); event.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={() => { setDragging(undefined); setDrop(undefined); }}
          onDragOver={event => { if (dragging && dragging !== task.id) { event.preventDefault(); setDrop({ id: task.id, placement: placementAt(event) }); } }}
          onDrop={event => { event.preventDefault(); const id = event.dataTransfer.getData('text/taskmd-id'); const placement = placementAt(event); setDrop(undefined); setDragging(undefined); if (id) move(() => moveOperations(state.tasks, id, task.id, placement)); }}>
          <button className="taskmd-fold" disabled={!count.total} aria-label={`${collapsed.has(task.id) ? '展开' : '折叠'} ${task.title}`} aria-expanded={count.total ? !collapsed.has(task.id) : undefined}
            onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(task.id)) next.delete(task.id); else next.add(task.id); return next; })}>{count.total ? collapsed.has(task.id) ? '▸' : '▾' : '·'}</button>
          <button className={`taskmd-outline-label${task.status === 'done' ? ' is-done' : ''}`} aria-current={selected === task.id ? 'true' : undefined} onClick={() => onSelect(task.id)}
            onKeyDown={event => { if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); move(() => indentOperations(state.tasks, task.id, event.shiftKey)); } }}>
            <strong>{task.status === 'done' && <span className="taskmd-done-mark" aria-hidden="true">✓ </span>}{task.title}</strong><small>{statusLabels[task.status]}{state.ready.includes(task.id) ? ' · 可开始' : blockerText ? ` · ${blockerText}` : ''}{task.archived ? ' · 已归档' : ''}
              {count.total > 0 && ` · ${count.done} 完成 / ${count.canceled} 取消 / ${count.total} 子任务`}</small>
          </button>
          <details className="taskmd-row-menu"><summary aria-label={`操作 ${task.title}`}>···</summary><div>
            <button disabled={busy || task.archived} onClick={() => { setAdding(task.id); setTitle(''); setReopen(false); setCollapsed(previous => { const next = new Set(previous); next.delete(task.id); return next; }); }}>添加子任务</button>
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
    {adding === null ? addForm(null) : <button className="taskmd-add-root" disabled={busy} onClick={() => { setAdding(null); setTitle(''); setReopen(false); }}>＋ 新建根任务</button>}
  </div>;
}
