import { useEffect, useId, useRef, useState } from 'react';
import type { State, TaskChanges, TaskRecord } from '../types.js';
import type { TaskPort } from './port.js';
import { descendants, failure } from './shared.js';
import { movedOrder } from './outline-model.js';

export function TaskProperties({ record, state, port, onChanged }: { record: TaskRecord; state: State; port: TaskPort; onChanged(): Promise<void> }) {
  const task = record.task;
  const [title, setTitle] = useState(task.title);
  const [parent, setParent] = useState(task.parent ?? '');
  const [order, setOrder] = useState(String(task.order));
  const previous = useRef(task);
  useEffect(() => {
    const before = previous.current;
    setTitle(value => value === before.title ? task.title : value);
    setParent(value => value === (before.parent ?? '') ? task.parent ?? '' : value);
    setOrder(value => value === String(before.order) ? String(task.order) : value);
    previous.current = task;
  }, [task]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const id = useId();
  const tasks = state.tasks.map(item => item.task);
  const excluded = descendants(tasks, task.id);
  const children = tasks.filter(item => item.parent === task.id);
  const update = async (changes: TaskChanges) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await port.updateTask(task.id, changes, record.version); await onChanged(); }
    catch (cause) { setError(failure(cause)); await onChanged(); }
    finally { setBusy(false); }
  };
  const move = (direction: -1 | 1) => {
    try { const next = movedOrder(tasks, task.id, direction); if (next !== undefined) void update({ order: next }); }
    catch (cause) { setError(failure(cause)); }
  };
  return <details className="taskmd-properties"><summary>任务设置</summary>
    <form onSubmit={event => {
      event.preventDefault();
      if (!title.trim() || !Number.isFinite(Number(order))) return;
      const changes: TaskChanges = {};
      if (title !== task.title) changes.title = title.trim();
      if ((parent || null) !== task.parent) changes.parent = parent || null;
      if (Number(order) !== task.order) changes.order = Number(order);
      if (Object.keys(changes).length) void update(changes);
    }}>
      <label htmlFor={`${id}-title`}>标题</label><input id={`${id}-title`} required value={title} onChange={event => setTitle(event.target.value)} />
      <label htmlFor={`${id}-parent`}>父任务</label><select id={`${id}-parent`} value={parent} onChange={event => setParent(event.target.value)}><option value="">顶层任务</option>{tasks.filter(item => !excluded.has(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      <label htmlFor={`${id}-order`}>同级排序值</label><input id={`${id}-order`} type="number" step="any" required value={order} onChange={event => setOrder(event.target.value)} />
      <button disabled={busy || !title.trim()}>保存任务设置</button>
    </form>
    <div className="taskmd-toolbar"><button disabled={busy} onClick={() => move(-1)}>上移</button><button disabled={busy} onClick={() => move(1)}>下移</button><button disabled={busy} onClick={() => void update({ archived: !task.archived })}>{task.archived ? '恢复任务' : '归档任务'}</button></div>
    <p className="taskmd-muted">归档会在大纲中隐藏整个分支，恢复后重新显示。</p>
    <details><summary>删除任务</summary>
      {children.length ? <p>请先移动或删除 {children.length} 个子任务：{children.map(item => item.title).join('、')}</p> : <><p>将删除此任务的 Markdown 文件。</p><button className="taskmd-danger" disabled={busy} onClick={() => {
        if (busy) return; setBusy(true); setError('');
        void port.deleteTask(task.id, record.version).then(onChanged).catch(cause => setError(failure(cause))).finally(() => setBusy(false));
      }}>确认删除叶子任务</button></>}
    </details>
    {error && <p role="alert" className="taskmd-error">{error}</p>}
  </details>;
}
