import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task, TaskSessionBinding } from '../types.js';
import type { SessionCapability, SessionStatus, TaskGraphPort } from './port.js';
import { chipLabel, levelLabels, levelOf } from './agent-status.js';
import { compareBindings, useAgentBindings, subtreeViews } from './taskmd-app.js';
import { outlineRows } from './outline-model.js';
import { failure, useTasks, statusLabels } from './shared.js';
import { isString, isStringList, useStored } from './view-state.js';
import { styles } from './styles.js';

interface SessionPickerState {
  taskId: string;
  anchor: HTMLElement;
  pinned: boolean;
}

/**
 * Read-only navigation sidebar. It intentionally does not mutate Task state:
 * the active-sessions region lists every running or attention session in this
 * Client, then the outline navigates Tasks, and the bottom region opens the
 * Sessions bound to the selected Task. The DSH-native sidebar is restored by
 * the separate footer switch.
 */
export function TaskmdLeftSidebar({ port, sessions, wide, expandSidebar, showSessions, onActivateSession, onOpenTask, sessionTitle }: {
  port: TaskGraphPort;
  sessions: SessionCapability;
  wide: boolean;
  expandSidebar(): void;
  showSessions(): void;
  /** Opens a bound Session through the DSH Client; the right-sidebar hand-off lives there. */
  onActivateSession?(taskId: string, sessionId: string): Promise<void>;
  /** Opens the taskmd main panel on a Task that has no bound Session. */
  onOpenTask?(taskId: string): void;
  /** The Client catalog's display title for one Session. */
  sessionTitle?(sessionId: string): string | undefined;
}) {
  const { state, error, refresh } = useTasks(port);
  const agent = useAgentBindings(sessions, port);
  const subtree = useMemo(() => subtreeViews(state?.tasks, agent.views), [state, agent.views]);
  const [selected, setSelected] = useStored<string | undefined>('leftSelected', undefined,
    (value): value is string | undefined => value === undefined || isString(value));
  const [collapsed, setCollapsed] = useStored('leftCollapsed', [] as string[], isStringList);
  const [repo, setRepo] = useStored('leftRepo', '', isString);
  const [query, setQuery] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyTask, setBusyTask] = useState<string>();
  const [picker, setPicker] = useState<SessionPickerState>();
  const activation = useRef(0);
  const hoverOpen = useRef<number>();
  const hoverClose = useRef<number>();
  const repositories = useMemo(() => [...new Set((state?.tasks ?? []).map(t => t.repo).filter((r): r is string => !!r))].sort(), [state]);
  const visible = useMemo(() => (state?.tasks ?? []).filter(task =>
    !task.archived && (!repo || task.repo === repo)
    && (!query.trim() || `${task.title} ${task.id} ${task.repo ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  ), [state, repo, query]);
  const selectedTask = state?.tasks.find(task => task.id === selected);

  useEffect(() => () => {
    if (hoverOpen.current !== undefined) window.clearTimeout(hoverOpen.current);
    if (hoverClose.current !== undefined) window.clearTimeout(hoverClose.current);
  }, []);

  const sessionTitleOf = (sessionId: string, status?: SessionStatus) =>
    sessionTitle?.(sessionId) || sessions.title?.(sessionId) || status?.title || sessionId;

  const clearHoverTimers = () => {
    if (hoverOpen.current !== undefined) { window.clearTimeout(hoverOpen.current); hoverOpen.current = undefined; }
    if (hoverClose.current !== undefined) { window.clearTimeout(hoverClose.current); hoverClose.current = undefined; }
  };
  const closePicker = (restoreFocus = false) => {
    clearHoverTimers();
    setPicker(current => {
      if (restoreFocus) current?.anchor.focus();
      return undefined;
    });
  };
  const scheduleClose = () => {
    // A quick pass over a row must cancel its pending hover-open; otherwise the
    // close timer fires first and the later open leaves the picker stranded
    // beside a row the pointer has already left.
    if (hoverOpen.current !== undefined) { window.clearTimeout(hoverOpen.current); hoverOpen.current = undefined; }
    if (hoverClose.current !== undefined) window.clearTimeout(hoverClose.current);
    hoverClose.current = window.setTimeout(() => {
      setPicker(current => current && !current.pinned ? undefined : current);
      hoverClose.current = undefined;
    }, 180);
  };
  const openPicker = (taskId: string, anchor: HTMLElement, pinned: boolean) => {
    clearHoverTimers();
    setPicker(current => current?.taskId === taskId && current.pinned === pinned && pinned ? undefined : { taskId, anchor, pinned });
  };
  const hoverPicker = (taskId: string, anchor: HTMLElement, delay = 250) => {
    // Re-entering the row before its close delay ends should keep the picker,
    // not close it and recreate it a delay later.
    if (hoverClose.current !== undefined) { window.clearTimeout(hoverClose.current); hoverClose.current = undefined; }
    if (hoverOpen.current !== undefined) window.clearTimeout(hoverOpen.current);
    hoverOpen.current = window.setTimeout(() => {
      setPicker(current => current?.pinned ? current : { taskId, anchor, pinned: false });
      hoverOpen.current = undefined;
    }, delay);
  };

  const resolveBindings = async (taskId: string): Promise<TaskSessionBinding[]> => {
    if (agent.loaded) return agent.bindingsByTask.get(taskId) ?? [];
    const items = await sessions.list(taskId);
    return [...items].sort(compareBindings);
  };

  const activate = async (taskId: string, chosenSessionId?: string) => {
    const token = ++activation.current;
    clearHoverTimers();
    setPicker(undefined);
    setActionError('');
    setSelected(taskId);
    setBusyTask(taskId);
    try {
      let sessionId = chosenSessionId;
      if (!sessionId) {
        const rows = await resolveBindings(taskId);
        if (token !== activation.current) return;
        sessionId = rows[0]?.sessionId;
      }
      if (!sessionId) {
        onOpenTask?.(taskId);
        return;
      }
      if (onActivateSession) await onActivateSession(taskId, sessionId);
      else await sessions.open(sessionId);
    } catch (reason) {
      if (token === activation.current) setActionError(failure(reason));
    } finally {
      if (token === activation.current) setBusyTask(undefined);
    }
  };

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
    {actionError && <p className="taskmd-error" role="alert">{actionError}</p>}
    <nav className="taskmd-left-list" aria-label="Taskmd 任务导航">
      <ul className="taskmd-tree">{outlineRows(visible, new Set(collapsed)).map(({ task, depth }) => {
        const children = visible.some(item => item.parent === task.id);
        const view = subtree.get(task.id);
        const chip = view ? chipLabel(view, view.statuses.length) : undefined;
        const taskSessions = agent.bindingsByTask.get(task.id) ?? [];
        return <li key={task.id} className="taskmd-left-item">
          <div className={`taskmd-left-row${selected === task.id ? ' is-selected' : ''}`}
            style={{ paddingLeft: `${Math.min(depth, 10) * 12 + 4}px` }}
            onMouseEnter={event => { if (taskSessions.length > 1) hoverPicker(task.id, event.currentTarget, 350); }}
            onMouseLeave={scheduleClose}>
            <button type="button" className="taskmd-left-fold" disabled={!children}
              aria-label={`${collapsed.includes(task.id) ? '展开' : '折叠'} ${task.title}`}
              aria-expanded={children ? !collapsed.includes(task.id) : undefined}
              onClick={() => setCollapsed(ids => ids.includes(task.id) ? ids.filter(id => id !== task.id) : [...ids, task.id])}>
              {children ? collapsed.includes(task.id) ? '▸' : '▾' : ''}
            </button>
            <span className={`taskmd-status-dot is-${task.status}`} role="img" aria-label={statusLabels[task.status]} />
            <button type="button" className="taskmd-left-label"
              aria-current={selected === task.id ? 'true' : undefined}
              disabled={busyTask === task.id}
              title={task.title} onClick={() => void activate(task.id)}>{task.title}</button>
            {taskSessions.length > 1 && <button type="button" className="taskmd-left-session-chip"
              aria-haspopup="dialog" aria-expanded={picker?.taskId === task.id}
              disabled={busyTask === task.id}
              title={`选择会话（${taskSessions.length}）`}
              onMouseEnter={event => { event.stopPropagation(); hoverPicker(task.id, event.currentTarget, 120); }}
              onMouseLeave={scheduleClose}
              onClick={event => { event.stopPropagation(); openPicker(task.id, event.currentTarget, true); }}>
              会话 {taskSessions.length}
            </button>}
            {chip && <span className={`taskmd-agent-chip is-${view!.level}`} title={chip}>{chip}</span>}
          </div>
        </li>;
      })}</ul>
      {state && visible.length === 0 && <p className="taskmd-muted">没有符合条件的任务</p>}
      {!state && !error && <p className="taskmd-muted">正在读取任务…</p>}
    </nav>
    {selectedTask && <SessionLinks taskId={selectedTask.id} title={selectedTask.title}
      bindings={agent.bindingsByTask.get(selectedTask.id)} statuses={agent.statuses}
      bindingError={agent.error} sessionTitle={sessionTitleOf} busy={busyTask === selectedTask.id}
      onOpenSession={sessionId => activate(selectedTask.id, sessionId)} />}
    {picker && (() => {
      const task = state?.tasks.find(item => item.id === picker.taskId);
      const bindings = agent.bindingsByTask.get(picker.taskId) ?? [];
      if (typeof document === 'undefined') return null;
      return createPortal(<SessionPicker task={task} taskId={picker.taskId} bindings={bindings}
        anchor={picker.anchor} pinned={picker.pinned} statuses={agent.statuses} sessionTitle={sessionTitleOf}
        onOpen={sessionId => { setPicker(undefined); void activate(picker.taskId, sessionId); }}
        onClose={closePicker} onEnter={() => { if (hoverClose.current !== undefined) { window.clearTimeout(hoverClose.current); hoverClose.current = undefined; } }}
        onLeave={scheduleClose} />, document.body);
    })()}
  </div>;
}

function bindingTime(binding: TaskSessionBinding): string {
  const value = binding.lastOpenedAt ?? binding.createdAt;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const label = binding.lastOpenedAt ? '最近打开' : '创建于';
  return `${label} ${date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

function pickerPosition(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, Math.max(220, window.innerWidth - 16));
  const left = Math.max(8, Math.min(rect.left + 8, window.innerWidth - width - 8));
  const top = window.innerHeight - rect.bottom > 220 ? rect.bottom + 4 : Math.max(8, rect.top - 304);
  return { left, top, width };
}

/** The multi-Session list, portalled so the DSH sidebar's overflow cannot clip it. */
function SessionPicker({ task, taskId, bindings, anchor, pinned, statuses, sessionTitle, onOpen, onClose, onEnter, onLeave }: {
  task?: Task; taskId: string; bindings: TaskSessionBinding[]; anchor: HTMLElement; pinned: boolean;
  statuses: Map<string, SessionStatus>;
  sessionTitle(sessionId: string, status?: SessionStatus): string;
  onOpen(sessionId: string): void;
  onClose(restoreFocus?: boolean): void;
  onEnter(): void;
  onLeave(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => pickerPosition(anchor));
  useEffect(() => {
    const update = () => setPosition(pickerPosition(anchor));
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [anchor]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || root.current?.contains(target) || anchor.contains(target)) return;
      onClose(false);
    };
    const scroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && root.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener('keydown', escape, true);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [anchor, onClose]);
  useEffect(() => {
    if (pinned) root.current?.querySelector<HTMLButtonElement>('[data-session-item]:not(:disabled)')?.focus();
  }, [pinned]);
  const move = (direction: 1 | -1) => {
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-session-item]:not(:disabled)') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + direction + items.length) % items.length]!.focus();
  };
  return <div ref={root} className="taskmd-session-picker" role="dialog" aria-label={`选择会话：${task?.title ?? taskId}`}
    style={{ left: position.left, top: position.top, width: position.width }}
    onMouseEnter={onEnter} onMouseLeave={onLeave}
    onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    }}>
    <div className="taskmd-session-picker-head">
      <span className="taskmd-session-picker-title" title={task?.title ?? taskId}>{task?.title ?? taskId}</span>
      <span className="taskmd-muted">{bindings.length} 个会话</span>
    </div>
    {bindings.map(binding => {
      const status = statuses.get(binding.sessionId);
      const archived = status?.archived;
      return <button type="button" key={binding.sessionId} data-session-item
        className="taskmd-session-picker-item" disabled={archived}
        title={archived ? '该会话已归档，先在 DSH 侧栏恢复' : binding.sessionId}
        onClick={() => onOpen(binding.sessionId)}>
        <span className={`taskmd-left-session-dot${status?.pending ? ' is-attention' : status?.running ? ' is-running' : status?.fresh ? ' is-fresh' : ''}`} />
        <span className="taskmd-session-picker-name">{sessionTitle(binding.sessionId, status)}</span>
        <span className="taskmd-session-picker-meta">{archived ? '已归档' : bindingTime(binding)}</span>
      </button>;
    })}
    {bindings.length === 0 && <p className="taskmd-muted">该任务没有会话。</p>}
  </div>;
}

function SessionLinks({ taskId, title, bindings, statuses, bindingError, sessionTitle, busy, onOpenSession }: {
  taskId: string; title: string; bindings?: TaskSessionBinding[]; statuses: Map<string, SessionStatus>;
  bindingError: string; sessionTitle(sessionId: string, status?: SessionStatus): string;
  busy: boolean; onOpenSession(sessionId: string): Promise<void>;
}) {
  return <section className="taskmd-left-sessions" aria-label="关联会话">
    <div className="taskmd-left-session-head" title={title}>
      <strong>关联会话</strong>
      {title && <span className="taskmd-left-task-name">{title}</span>}
      <span className="taskmd-muted">{bindings?.length ?? '…'}</span>
    </div>
    {bindingError && <p className="taskmd-error" role="alert">{bindingError}</p>}
    {bindings?.map(binding => {
      const status = statuses.get(binding.sessionId);
      const archived = status?.archived;
      return <button type="button" key={binding.sessionId} className="taskmd-left-session"
        title={archived ? '该会话已归档，先在 DSH 侧栏恢复' : binding.sessionId}
        disabled={busy || archived} onClick={() => void onOpenSession(binding.sessionId)}>
        <span className={`taskmd-left-session-dot${status?.pending ? ' is-attention' : status?.running ? ' is-running' : status?.fresh ? ' is-fresh' : ''}`} />
        <span className="taskmd-left-session-title">{sessionTitle(binding.sessionId, status)}</span>
        <small>{archived ? '已归档' : status ? levelLabels[levelOf(status)] : '未知'}</small>
      </button>;
    })}
    {bindings && bindings.length === 0 && <p className="taskmd-muted">该任务尚无关联会话</p>}
    {!bindings && !bindingError && <p className="taskmd-muted">正在读取会话…</p>}
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
    catch (reason) { setError(failure(reason)); }
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
          <span className="taskmd-left-session-title">{sessions.title?.(status.sessionId) || status.title || status.sessionId}</span>
          <small>{status.pending ? '等你处理' : status.fresh ? '有新结果' : status.runningSubagents ? `运行中 · ${status.runningSubagents} 子代理` : '运行中'}</small>
        </button>)}
      </div>
      {rows.length === 0 && <p className="taskmd-muted">暂无进行中的会话</p>}
    </>}
  </section>;
}
