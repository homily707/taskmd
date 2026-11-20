import { useId, useMemo, useState, type CSSProperties } from 'react';
import type { State } from '../types.js';
import type { TaskPort } from './port.js';
import { chipLabel } from './agent-status.js';
import { outlineRows } from './outline-model.js';
import { failure, statusLabels, subtreeViews, useAgentView } from './shared.js';

export function TaskOutline({ state, port, selected, onSelect, onChanged, agent }: {
  state: State; port: TaskPort; selected?: string; onSelect(id: string): void;
  onChanged(): Promise<void>; agent: ReturnType<typeof useAgentView>;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [title, setTitle] = useState('');
  const [parent, setParent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ids = useId();
  const rows = outlineRows(state.tasks, collapsed, archived, query);
  const subtree = useMemo(() => subtreeViews(state.tasks.map(record => record.task), agent.views), [state, agent.views]);
  return <nav aria-label="任务大纲" className="taskmd-outline">
    <div className="taskmd-filters">
      <label className="taskmd-visually-hidden" htmlFor={`${ids}-search`}>搜索任务</label>
      <input id={`${ids}-search`} type="search" aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)} />
      <label className="taskmd-check"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />含归档</label>
    </div>
    <details className="taskmd-create"><summary><span aria-hidden="true">＋</span> 新建任务</summary>
      <form onSubmit={event => {
        event.preventDefault(); if (busy || !title.trim()) return;
        setBusy(true); setError('');
        void port.createTask({ title: title.trim(), parent: parent || null }).then(async record => {
          setTitle(''); await onChanged(); onSelect(record.task.id);
        }).catch(cause => setError(failure(cause))).finally(() => setBusy(false));
      }}>
        <label htmlFor={`${ids}-title`}>任务标题</label><input id={`${ids}-title`} aria-label="任务标题" required value={title} onChange={event => setTitle(event.target.value)} />
        <label htmlFor={`${ids}-parent`}>父任务（可选）</label><select id={`${ids}-parent`} value={parent} onChange={event => setParent(event.target.value)}>
          <option value="">顶层任务</option>{state.tasks.filter(record => !record.task.archived).map(({ task }) => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select><button disabled={busy || !title.trim() || !state.settings.homeDirectory}>创建任务</button>
      </form>
    </details>
    {(error || agent.error) && <p role="alert" className="taskmd-error">{error || agent.error}</p>}
    <ul className="taskmd-tree taskmd-outline-tree">{rows.map(({ task, depth, hasChildren }) => {
      const view = subtree.get(task.id);
      const chip = view ? chipLabel(view, view.statuses.length) : undefined;
      return <li key={task.id} style={{ '--task-depth': depth } as CSSProperties}>
        <div className={`taskmd-outline-row${selected === task.id ? ' is-selected' : ''}${task.archived ? ' is-archived' : ''}`}>
          {hasChildren ? <button type="button" className="taskmd-fold" aria-label={`${collapsed.has(task.id) ? '展开' : '收起'} ${task.title}`} aria-expanded={!collapsed.has(task.id)} onClick={() => setCollapsed(previous => {
            const next = new Set(previous); if (next.has(task.id)) next.delete(task.id); else next.add(task.id); return next;
          })}>{collapsed.has(task.id) ? '▸' : '▾'}</button> : <span className="taskmd-fold" aria-hidden="true" />}
          <span className={`taskmd-status-dot is-${task.status}`} role="img" aria-label={`任务状态：${statusLabels[task.status]}`} />
          <button type="button" className="taskmd-outline-label" aria-current={selected === task.id ? 'page' : undefined} onClick={() => onSelect(task.id)}>
            <strong>{task.title}</strong><small>{statusLabels[task.status]}{task.archived ? ' · 已归档' : ''}</small>
          </button>
          {chip && <span className={`taskmd-agent-chip is-${view!.level}`} title={chip}>{chip}</span>}
        </div>
      </li>;
    })}</ul>
    {!rows.length && <p className="taskmd-empty-inline">{query ? '没有匹配的任务。' : '从新建任务开始，正文保存在 Home。'}</p>}
  </nav>;
}
