import { useEffect, useMemo, useState } from 'react';
import type { TaskSessionBinding } from '../types.js';
import type { SessionCapability, SessionStatus, TaskGraphPort } from './port.js';
import { chipLabel, levelLabels, levelOf } from './agent-status.js';
import { useAgentBindings, subtreeViews } from './taskmd-app.js';
import { outlineRows } from './outline-model.js';
import { useTasks, statusLabels } from './shared.js';
import { isString, isStringList, useStored } from './view-state.js';
import { styles } from './styles.js';

/**
 * Read-only navigation sidebar. It intentionally does not mutate Task state:
 * the active-sessions region lists every running or attention session in this
 * Client, then the outline navigates Tasks, and the bottom region opens the
 * Sessions bound to the selected Task. The DSH-native sidebar is restored by
 * the separate footer switch.
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
    <ActiveSessions sessions={sessions} />
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
    <div className="taskmd-left-session-head" title={title}>
      <strong>关联会话</strong>
      {title && <span className="taskmd-left-task-name">{title}</span>}
      <span className="taskmd-muted">{bindings?.length ?? '…'}</span>
    </div>
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

/**
 * Every session in this Client that is running, waiting for the user or has an
 * unread fresh completion, regardless of Task bindings — the same session may
 * also appear below in the bound-Sessions region; the two lists are
 * deliberately not deduplicated. Rows keep catalog order within each group so
 * streaming does not reshuffle. Opening a session clears its fresh flag, so it
 * leaves this region on its own once the user has looked at it.
 */
function ActiveSessions({ sessions }: { sessions: SessionCapability }) {
  const statusSource = sessions.statuses?.();
  const [collapsed, setCollapsed] = useStored('leftActiveCollapsed', false,
    (value): value is boolean => typeof value === 'boolean');
  const [tick, setTick] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => statusSource?.subscribe(() => setTick(value => value + 1)), [statusSource]);
  const active = useMemo(() => {
    if (!statusSource) return undefined;
    const attention: SessionStatus[] = [];
    const fresh: SessionStatus[] = [];
    const running: SessionStatus[] = [];
    for (const status of statusSource.get().values()) {
      if (status.archived) continue;
      if (status.pending) attention.push(status);
      else if (status.fresh) fresh.push(status);
      else if (status.running) running.push(status);
    }
    return { attention, fresh, running };
  }, [statusSource, tick]);
  const open = async (sessionId: string) => {
    setError('');
    try { await sessions.open(sessionId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  if (!statusSource || !active) return null;
  const rows = [...active.attention, ...active.fresh, ...active.running];

  return <section className="taskmd-left-active" aria-label="进行中的会话">
    <div className="taskmd-left-active-head">
      <button type="button" className="taskmd-left-fold"
        aria-label={collapsed ? '展开进行中的会话' : '折叠进行中的会话'}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? '▸' : '▾'}
      </button>
      <strong>进行中的会话</strong>
      {active.attention.length > 0 && <span className="taskmd-left-attention" title="等待你处理的会话数">⚠ {active.attention.length}</span>}
      <span className="taskmd-muted" title={`运行中 ${active.running.length} · 有新结果 ${active.fresh.length} · 等待处理 ${active.attention.length}`}>{rows.length}</span>
    </div>
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    {!collapsed && <>
      <div className="taskmd-left-active-list">
        {rows.map(status => <button type="button" key={status.sessionId} className="taskmd-left-session"
          title={status.sessionId} onClick={() => void open(status.sessionId)}>
          <span className={`taskmd-left-session-dot${status.pending ? ' is-attention' : status.fresh ? ' is-fresh' : ' is-running'}`} />
          <span className="taskmd-left-session-title">{status.title || status.sessionId}</span>
          <small>{status.pending ? '等你处理' : status.fresh ? '有新结果' : status.runningSubagents ? `运行中 · ${status.runningSubagents} 子代理` : '运行中'}</small>
        </button>)}
      </div>
      {rows.length === 0 && <p className="taskmd-muted">暂无进行中的会话</p>}
    </>}
  </section>;
}
