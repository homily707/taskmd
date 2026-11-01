import { useEffect, useMemo, useState } from 'react';
import type { TaskSessionBinding } from '../types.js';
import type { SessionCapability, TaskGraphPort } from './port.js';
import { chipLabel, levelLabels, levelOf } from './agent-status.js';
import { useAgentBindings, subtreeViews } from './taskmd-app.js';
import { outlineRows } from './outline-model.js';
import { useTasks, statusLabels } from './shared.js';
import { isString, isStringList, useStored } from './view-state.js';
import { styles } from './styles.js';

/**
 * Read-only navigation sidebar. It intentionally does not mutate Task state:
 * select a Task to see all of its bound Sessions, then open the chosen chat.
 * The DSH-native sidebar is restored by the separate footer switch.
 */
export function TaskmdLeftSidebar({ port, sessions, wide, expandSidebar, showSessions }: {
  port: TaskGraphPort;
  sessions: SessionCapability;
  wide: boolean;
  expandSidebar(): void;
  showSessions(): void;
}) {
  const { state, error, refresh } = useTasks(port);
  const agent = useAgentBindings(sessions, port);
  const subtree = useMemo(() => subtreeViews(state?.tasks, agent.views), [state, agent.views]);
  const [selected, setSelected] = useStored<string | undefined>('leftSelected', undefined,
    (value): value is string | undefined => value === undefined || isString(value));
  const [collapsed, setCollapsed] = useStored('leftCollapsed', [] as string[], isStringList);
  const [repo, setRepo] = useStored('leftRepo', '', isString);
  const [query, setQuery] = useState('');
  const repositories = useMemo(() => [...new Set((state?.tasks ?? []).map(t => t.repo).filter((r): r is string => !!r))].sort(), [state]);
  const visible = useMemo(() => (state?.tasks ?? []).filter(task =>
    !task.archived && (!repo || task.repo === repo)
    && (!query.trim() || `${task.title} ${task.id} ${task.repo ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  ), [state, repo, query]);
  const selectedTask = state?.tasks.find(task => task.id === selected);

  // In rail mode the region must be a small expand control, not a squeezed tree.
  if (!wide) return <button type="button" className="taskmd-left-rail" title="展开任务大纲"
    aria-label="展开任务大纲" onClick={expandSidebar}>☷</button>;

  return <div className="taskmd-app taskmd-left-sidebar">
    <style>{styles}</style>
    <div className="taskmd-left-top">
      <strong>任务大纲</strong>
      <span className="taskmd-muted">{visible.length}</span>
      {agent.enabled && agent.totals.attention > 0 && <span className="taskmd-left-attention" title="等待你处理的会话数">⚠ {agent.totals.attention}</span>}
      <button type="button" title="刷新任务" aria-label="刷新任务" onClick={() => void refresh()}>↻</button>
      <button type="button" title="恢复原生 Session 列表" onClick={showSessions}>会话</button>
    </div>
    <div className="taskmd-left-filters">
      <input aria-label="搜索任务大纲" placeholder="搜索任务…" value={query} onChange={event => setQuery(event.target.value)} />
      {repositories.length > 1 && <select aria-label="筛选仓库" value={repo} onChange={event => setRepo(event.target.value)}>
        <option value="">全部仓库</option>
        {repositories.map(name => <option key={name} value={name}>{name}</option>)}
      </select>}
    </div>
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    <nav className="taskmd-left-list" aria-label="Taskmd 任务导航">
      <ul className="taskmd-tree">{outlineRows(visible, new Set(collapsed)).map(({ task, depth }) => {
        const children = visible.some(item => item.parent === task.id);
        const view = subtree.get(task.id);
        const chip = view ? chipLabel(view, view.statuses.length) : undefined;
        return <li key={task.id} className="taskmd-left-item">
          <div className={`taskmd-left-row${selected === task.id ? ' is-selected' : ''}`}
            style={{ paddingLeft: `${Math.min(depth, 10) * 12 + 4}px` }}>
            <button type="button" className="taskmd-left-fold" disabled={!children}
              aria-label={`${collapsed.includes(task.id) ? '展开' : '折叠'} ${task.title}`}
              aria-expanded={children ? !collapsed.includes(task.id) : undefined}
              onClick={() => setCollapsed(ids => ids.includes(task.id) ? ids.filter(id => id !== task.id) : [...ids, task.id])}>
              {children ? collapsed.includes(task.id) ? '▸' : '▾' : ''}
            </button>
            <span className={`taskmd-status-dot is-${task.status}`} role="img" aria-label={statusLabels[task.status]} />
            <button type="button" className="taskmd-left-label"
              aria-current={selected === task.id ? 'true' : undefined}
              title={task.title} onClick={() => setSelected(task.id)}>{task.title}</button>
            {chip && <span className={`taskmd-agent-chip is-${view!.level}`} title={chip}>{chip}</span>}
          </div>
        </li>;
      })}</ul>
      {state && visible.length === 0 && <p className="taskmd-muted">没有符合条件的任务</p>}
      {!state && !error && <p className="taskmd-muted">正在读取任务…</p>}
    </nav>
    {selectedTask && <SessionLinks taskId={selectedTask.id} title={selectedTask.title}
      sessions={sessions} port={port} />}
  </div>;
}

function SessionLinks({ taskId, title, sessions, port }: {
  taskId: string; title: string; sessions: SessionCapability; port: TaskGraphPort;
}) {
  const [bindings, setBindings] = useState<TaskSessionBinding[]>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [tick, setTick] = useState(0);
  const statusSource = sessions.statuses?.();
  useEffect(() => port.subscribe(() => setRevision(value => value + 1)), [port]);
  useEffect(() => statusSource?.subscribe(() => setTick(value => value + 1)), [statusSource]);
  useEffect(() => {
    const controller = new AbortController();
    setBindings(undefined);
    setError('');
    void sessions.list(taskId, controller.signal).then(items => {
      if (!controller.signal.aborted) setBindings([...items].sort((a, b) =>
        (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt)));
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
  }, [sessions, taskId, revision]);
  const statuses = useMemo(() => statusSource?.get(), [statusSource, tick]);
  const open = async (sessionId: string) => {
    setError('');
    try { await sessions.open(sessionId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  return <section className="taskmd-left-sessions" aria-label="关联会话">
    <div className="taskmd-left-session-head" title={title}><strong>关联会话</strong><span className="taskmd-muted">{bindings?.length ?? '…'}</span></div>
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    {bindings?.map(binding => {
      const status = statuses?.get(binding.sessionId);
      return <button type="button" key={binding.sessionId} className="taskmd-left-session"
        title={binding.sessionId} onClick={() => void open(binding.sessionId)}>
        <span className={`taskmd-left-session-dot${status?.pending ? ' is-attention' : status?.running ? ' is-running' : status?.fresh ? ' is-fresh' : ''}`} />
        <span className="taskmd-left-session-title">{status?.title || binding.sessionId}</span>
        <small>{status ? levelLabels[levelOf(status)] : '未知'}</small>
      </button>;
    })}
    {bindings && bindings.length === 0 && <p className="taskmd-muted">该任务尚无关联会话</p>}
    {!bindings && !error && <p className="taskmd-muted">正在读取会话…</p>}
  </section>;
}
