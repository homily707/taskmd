import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { TaskRecord, TaskSessionBinding } from '../types.js';
import type { SessionCapability, SessionStatus, TaskPort } from './port.js';
import { chipLabel, levelLabels, levelOf, relativeActivity } from './agent-status.js';
import { outlineRows } from './outline-model.js';
import { HomeConfiguration } from './settings.js';
import { failure, sessionLabel, statusLabels, useAgentView, useTasks } from './shared.js';
import { isString, isStringList, useStored } from './view-state.js';
import { styles } from './styles.js';

const isStringOrUndefined = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string';
const toggle = (list: string[], id: string) => list.includes(id) ? list.filter(value => value !== id) : [...list, id];

/** One compact aggregate for a Task row: session count tinted by the worst Session state. */
function sessionBadge(statuses: SessionStatus[], count: number): { text: string; level: string } {
  const levels = statuses.map(levelOf);
  if (levels.includes('attention')) return { text: `⚠ ${count}`, level: 'attention' };
  if (levels.includes('running')) return { text: `● ${count}`, level: 'running' };
  if (levels.includes('fresh')) return { text: `✓ ${count}`, level: 'fresh' };
  return { text: String(count), level: 'idle' };
}

interface SessionPickerState {
  taskId: string;
  anchor: HTMLElement;
  pinned: boolean;
}

/**
 * Task-first navigation column. Task rows stay a single compact line; their
 * Sessions are never expanded between Tasks. A Task opens its Markdown, while
 * the small Session badge opens a floating list to the right of the column.
 * Agent state is display-only; it never writes task status or completion.
 */
export function TaskmdLeftSidebar({ port, sessions, wide, expandSidebar, onOpenTask, onActivateSession, showSessions, activeSessionId }: {
  port: TaskPort; sessions: SessionCapability; wide: boolean; expandSidebar(): void;
  onOpenTask(id: string): void; onActivateSession?(taskId: string, sessionId: string): Promise<void>; showSessions(): void;
  activeSessionId?: string;
}) {
  const { state, error, refresh } = useTasks(port);
  const agent = useAgentView(sessions, port);
  const [selected, setSelected] = useStored<string | undefined>('leftSelected', undefined, isStringOrUndefined);
  const [collapsedList, setCollapsedList] = useStored<string[]>('leftCollapsed', [], isStringList);
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState('');
  const [title, setTitle] = useState('');
  const [parent, setParent] = useState('');
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState('');
  const [picker, setPicker] = useState<SessionPickerState>();
  const hoverOpen = useRef<number>();
  const hoverClose = useRef<number>();
  const ids = useId();
  const collapsed = useMemo(() => new Set(collapsedList), [collapsedList]);
  const rows = useMemo(() => outlineRows(state?.tasks ?? [], collapsed, archived, query), [state, collapsed, archived, query]);
  const taskCount = state?.tasks.filter(record => !record.task.archived).length;
  const homeName = state?.settings.homeDirectory.split(/[\\/]/).filter(Boolean).pop();
  // Entering a Session owns the row highlight: its bound Task, if any, is the
  // selection; a Session with no bound Task selects nothing.
  let activeTaskId: string | undefined;
  if (activeSessionId) {
    for (const [taskId, list] of agent.bindingsByTask) {
      if (list.some(binding => binding.sessionId === activeSessionId)) { activeTaskId = taskId; break; }
    }
  }
  const highlighted = activeSessionId ? activeTaskId : selected;

  const clearHover = useCallback(() => {
    if (hoverOpen.current !== undefined) { window.clearTimeout(hoverOpen.current); hoverOpen.current = undefined; }
    if (hoverClose.current !== undefined) { window.clearTimeout(hoverClose.current); hoverClose.current = undefined; }
  }, []);
  const closePicker = useCallback((restoreFocus = false) => {
    clearHover();
    setPicker(current => {
      if (restoreFocus) current?.anchor.focus();
      return undefined;
    });
  }, [clearHover]);
  useEffect(() => clearHover, [clearHover]);
  const scheduleClose = useCallback(() => {
    if (hoverOpen.current !== undefined) { window.clearTimeout(hoverOpen.current); hoverOpen.current = undefined; }
    if (hoverClose.current !== undefined) window.clearTimeout(hoverClose.current);
    hoverClose.current = window.setTimeout(() => {
      setPicker(current => current && !current.pinned ? undefined : current);
      hoverClose.current = undefined;
    }, 180);
  }, []);
  const openPicker = (taskId: string, anchor: HTMLElement, pinned: boolean) => {
    clearHover();
    setPicker(current => current?.taskId === taskId && current.pinned === pinned && pinned ? undefined : { taskId, anchor, pinned });
  };
  const hoverPicker = (taskId: string, anchor: HTMLElement, delay = 300) => {
    if (hoverClose.current !== undefined) { window.clearTimeout(hoverClose.current); hoverClose.current = undefined; }
    if (hoverOpen.current !== undefined) window.clearTimeout(hoverOpen.current);
    hoverOpen.current = window.setTimeout(() => {
      setPicker(current => current?.pinned ? current : { taskId, anchor, pinned: false });
      hoverOpen.current = undefined;
    }, delay);
  };

  const openSession = async (taskId: string, sessionId: string) => {
    if (agent.statuses.get(sessionId)?.archived) throw new Error('该 Session 已归档，请先在 DSH 会话列表中恢复。');
    if (onActivateSession) await onActivateSession(taskId, sessionId);
    else await sessions.open(sessionId);
  };

  const activateTask = async (record: TaskRecord) => {
    if (busy) return;
    const id = record.task.id;
    setSelected(id);
    setActionError('');
    clearHover();
    setPicker(undefined);
    const bindings = agent.bindingsByTask.get(id) ?? [];
    const first = bindings.find(binding => !agent.statuses.get(binding.sessionId)?.archived);
    if (!first) { onOpenTask(id); return; }
    setBusy(id);
    try { await openSession(id, first.sessionId); }
    catch (cause) { setActionError(failure(cause)); }
    finally { setBusy(undefined); }
  };

  const activateSession = async (taskId: string, sessionId: string) => {
    if (busy) return;
    setSelected(taskId);
    setActionError('');
    setBusy(taskId);
    try { await openSession(taskId, sessionId); }
    catch (cause) { setActionError(failure(cause)); }
    finally { setBusy(undefined); }
  };

  if (!wide) return <div className="taskmd-app taskmd-left-rail-wrap"><style>{styles}</style>
    <button type="button" className="taskmd-rail-button" title="展开任务大纲" aria-label="展开任务大纲" onClick={expandSidebar}>
      <span aria-hidden="true">☰</span><span className="taskmd-visually-hidden">任务大纲</span>
    </button>
    <button type="button" className="taskmd-rail-button" title="切换到 DSH 会话列表" aria-label="切换到 DSH 会话列表" onClick={showSessions}>
      <span aria-hidden="true">◫</span><span className="taskmd-visually-hidden">会话列表</span>
    </button>
  </div>;

  const pickerTask = picker ? state?.tasks.find(record => record.task.id === picker.taskId) : undefined;

  return <aside className="taskmd-app taskmd-left-sidebar">
    <style>{styles}</style>
    <header className="taskmd-left-header">
      <div className="taskmd-left-brand"><h2>任务</h2><span className="taskmd-count">{taskCount ?? '…'}</span></div>
      <div className="taskmd-left-tools">
        <button type="button" className="taskmd-icon-button" aria-label="新建任务" title="新建任务" aria-expanded={createOpen} onClick={() => setCreateOpen(value => !value)}>＋</button>
        <button type="button" className="taskmd-icon-button" aria-label="刷新任务" title="刷新任务" onClick={() => void refresh()}>↻</button>
        <button type="button" className="taskmd-text-button" onClick={showSessions}>会话</button>
      </div>
    </header>
    <ActiveSessions sessions={sessions} />
    <div className="taskmd-left-search">
      <label className="taskmd-visually-hidden" htmlFor={`${ids}-search`}>搜索任务</label>
      <div className="taskmd-search-box">
        <span aria-hidden="true" className="taskmd-search-icon">⌕</span>
        <input id={`${ids}-search`} type="search" value={query} placeholder="搜索任务" onChange={event => setQuery(event.target.value)} />
        {!!query && <button type="button" className="taskmd-search-clear" aria-label="清除搜索" onClick={() => setQuery('')}>×</button>}
      </div>
    </div>
    {createOpen && <form className="taskmd-left-create" onSubmit={event => {
      event.preventDefault(); if (creating || !title.trim()) return;
      setCreating(true); setCreateError('');
      void port.createTask({ title: title.trim(), parent: parent || null }).then(async record => {
        setTitle(''); setParent(''); setCreateOpen(false); await refresh(); setSelected(record.task.id); onOpenTask(record.task.id);
      }).catch(cause => setCreateError(failure(cause))).finally(() => setCreating(false));
    }}>
      <label className="taskmd-visually-hidden" htmlFor={`${ids}-title`}>任务标题</label>
      <input id={`${ids}-title`} aria-label="任务标题" placeholder="任务标题" required autoFocus value={title} onChange={event => setTitle(event.target.value)} />
      <label className="taskmd-visually-hidden" htmlFor={`${ids}-parent`}>父任务（可选）</label>
      <select id={`${ids}-parent`} aria-label="父任务" value={parent} onChange={event => setParent(event.target.value)}>
        <option value="">顶层任务</option>
        {state?.tasks.filter(record => !record.task.archived).map(({ task }) => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select>
      <div className="taskmd-left-create-actions">
        <button type="submit" disabled={creating || !title.trim() || !state?.settings.homeDirectory}>{creating ? '创建中…' : '创建'}</button>
        <button type="button" onClick={() => setCreateOpen(false)}>取消</button>
      </div>
      {createError && <p role="alert" className="taskmd-error">{createError}</p>}
    </form>}
    <div className="taskmd-left-scroll">
      {(error || actionError || agent.error) && <p role="alert" className="taskmd-error">{error || actionError || agent.error} <button type="button" className="taskmd-inline-button" onClick={() => void refresh()}>重试</button></p>}
      <nav aria-label="任务导航">
        <ul className="taskmd-tree taskmd-nav-tree">{rows.map(({ task, depth, hasChildren }) => {
          const bindings = agent.bindingsByTask.get(task.id) ?? [];
          const statuses = bindings.map(binding => agent.statuses.get(binding.sessionId)).filter((status): status is SessionStatus => !!status);
          const badge = bindings.length ? sessionBadge(statuses, bindings.length) : undefined;
          const view = agent.views.get(task.id);
          const chip = view ? chipLabel(view, view.statuses.length) : undefined;
          return <li key={task.id} style={{ '--task-depth': depth } as CSSProperties}>
            <div className={`taskmd-nav-row${highlighted === task.id ? ' is-selected' : ''}${busy === task.id ? ' is-busy' : ''}`}
              onMouseEnter={event => { if (bindings.length) hoverPicker(task.id, event.currentTarget); }}
              onMouseLeave={scheduleClose}>
              <button type="button" className="taskmd-nav-hit"
                aria-label={bindings.length ? `打开 ${task.title}，进入第一个会话` : `打开 ${task.title}`}
                title={`${task.title} · ${statusLabels[task.status]}`}
                aria-current={highlighted === task.id ? 'true' : undefined}
                disabled={busy === task.id}
                onClick={() => void activateTask(state!.tasks.find(record => record.task.id === task.id)!)} />
              {hasChildren
                ? <button type="button" className="taskmd-nav-fold" aria-label={`${collapsed.has(task.id) ? '展开' : '折叠'} ${task.title} 的子任务`} aria-expanded={!collapsed.has(task.id)} onClick={() => setCollapsedList(previous => toggle(previous, task.id))}>{collapsed.has(task.id) ? '▸' : '▾'}</button>
                : <span className="taskmd-nav-fold" aria-hidden="true" />}
              <span className={`taskmd-status-dot is-${task.status}`} role="img" aria-label={`任务状态：${statusLabels[task.status]}`} />
              <span className="taskmd-nav-label" title={`${task.title} · ${statusLabels[task.status]}`}>
                <span className="taskmd-nav-title">{task.title}</span>
              </span>
              {badge && <button type="button" className={`taskmd-session-badge is-${badge.level}`}
                aria-label={`${task.title} 的 ${bindings.length} 个会话${chip ? `，${chip}` : ''}`}
                title={chip ? `${chip} · ${bindings.length} 个会话` : `${bindings.length} 个会话`}
                aria-expanded={picker?.taskId === task.id}
                disabled={busy === task.id}
                onClick={event => { event.stopPropagation(); openPicker(task.id, event.currentTarget, true); }}>{badge.text}</button>}
            </div>
          </li>;
        })}</ul>
      </nav>
      {!rows.length && <div className="taskmd-empty-inline">{query ? '没有匹配的任务。' : state ? '还没有任务。' : '正在读取任务…'}{query && <button type="button" className="taskmd-inline-button" onClick={() => setQuery('')}>清除搜索</button>}</div>}
    </div>
    <footer className="taskmd-left-footer">
      <div className="taskmd-left-footer-row">
        <label className="taskmd-check taskmd-archive-toggle" title="显示已归档任务"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />已归档</label>
        <p className="taskmd-home" title={state?.settings.homeDirectory}>Home · {homeName || '尚未配置'}</p>
      </div>
      <HomeConfiguration key={`${state?.settings.homeDirectory}:${state?.settings.tasksDirectory}`} settings={state?.settings ?? { homeDirectory: '', homeWorkspaceId: null, tasksDirectory: 'tasks' }} port={port} sessions={sessions} onChanged={refresh} />
      {!!state?.diagnostics.length && <details className="taskmd-diagnostics"><summary>文件提示 · {state.diagnostics.length}</summary><ul>{state.diagnostics.map((item, index) => <li key={index}>{item.path}：{item.message}</li>)}</ul></details>}
    </footer>
    {picker && pickerTask && typeof document !== 'undefined' && createPortal(<SessionPopover
      taskTitle={pickerTask.task.title} anchor={picker.anchor} pinned={picker.pinned}
      bindings={agent.bindingsByTask.get(picker.taskId) ?? []} statuses={agent.statuses}
      sessionTitle={(sessionId, status) => sessionLabel(sessions, sessionId, status)}
      onOpen={sessionId => { setPicker(undefined); void activateSession(picker.taskId, sessionId); }}
      onEnter={() => { if (hoverClose.current !== undefined) { window.clearTimeout(hoverClose.current); hoverClose.current = undefined; } }}
      onLeave={scheduleClose} onClose={closePicker} />, document.body)}
  </aside>;
}

/**
 * The five most recently updated Sessions in this Client, regardless of Task
 * bindings or activity. Active Sessions keep updating, so they stay near the
 * top naturally; the pills in the header still summarize every Session that
 * waits on the user, runs, or carries an unread result.
 */
function ActiveSessions({ sessions }: { sessions: SessionCapability }) {
  const statusSource = sessions.statuses?.();
  const [collapsed, setCollapsed] = useStored('leftActiveCollapsed', false,
    (value): value is boolean => typeof value === 'boolean');
  const [tick, setTick] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => statusSource?.subscribe(() => setTick(value => value + 1)), [statusSource]);
  const summary = useMemo(() => {
    if (!statusSource) return undefined;
    const visible: SessionStatus[] = [];
    let attention = 0, running = 0, fresh = 0;
    for (const status of statusSource.get().values()) {
      if (status.archived || status.missing || status.blank) continue;
      visible.push(status);
      if (status.pending) attention += 1;
      else if (status.running) running += 1;
      else if (status.fresh) fresh += 1;
    }
    visible.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { visible, attention, running, fresh };
  }, [statusSource, tick]);
  const open = async (sessionId: string) => {
    setError('');
    try { await sessions.open(sessionId); }
    catch (reason) { setError(failure(reason)); }
  };
  if (!statusSource || !summary) return null;
  const rows = summary.visible.slice(0, 5);
  if (!rows.length) return null;

  return <section className="taskmd-left-active" aria-label="最近会话">
    <div className="taskmd-left-active-head">
      <button type="button" className="taskmd-nav-fold" aria-label={collapsed ? '展开最近会话' : '折叠最近会话'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '▸' : '▾'}</button>
      <strong>最近会话</strong>
      {summary.attention > 0 && <span className="taskmd-agent-pill is-attention" title="等待你处理的会话数">⚠ {summary.attention}</span>}
      {summary.running > 0 && <span className="taskmd-agent-pill is-running" title="运行中的会话数">● {summary.running}</span>}
      {summary.fresh > 0 && <span className="taskmd-agent-pill is-fresh" title="有新结果的会话数">✓ {summary.fresh}</span>}
      <span className="taskmd-muted" title={`共 ${rows.length} 个`}>{rows.length}</span>
    </div>
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    {!collapsed && <div className="taskmd-left-active-list">
      {rows.map(status => {
        const meta = status.pending ? '等你处理' : status.fresh ? '有新结果'
          : status.running ? (status.runningSubagents ? `运行 · ${status.runningSubagents} 子代理` : '运行中')
          : relativeActivity(status, Date.now());
        return <button type="button" key={status.sessionId} className="taskmd-active-session"
          title={status.sessionId} onClick={() => void open(status.sessionId)}>
          <span className={`taskmd-session-dot is-${levelOf(status)}`} aria-hidden="true" />
          <span className="taskmd-active-session-title">{sessions.title?.(status.sessionId) || status.title || status.sessionId}</span>
          <span className="taskmd-active-session-meta">{meta}</span>
        </button>;
      })}
    </div>}
  </section>;
}

/** Place the floating list just outside the inner edge of the sidebar; flip to the left when needed. */
function popoverPosition(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = 272;
  const height = Math.min(320, window.innerHeight - 16);
  let left = rect.right + 8;
  if (left + width > window.innerWidth - 8) left = Math.max(8, rect.left - width - 8);
  let top = rect.top - 2;
  if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - height);
  return { left, top, width, maxHeight: height };
}

/** Portalled so the DSH sidebar's overflow cannot clip it. */
function SessionPopover({ taskTitle, anchor, pinned, bindings, statuses, sessionTitle, onOpen, onClose, onEnter, onLeave }: {
  taskTitle: string; anchor: HTMLElement; pinned: boolean; bindings: TaskSessionBinding[];
  statuses: Map<string, SessionStatus>;
  sessionTitle(sessionId: string, status?: SessionStatus): string;
  onOpen(sessionId: string): void; onClose(restoreFocus?: boolean): void; onEnter(): void; onLeave(): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(() => popoverPosition(anchor));
  useEffect(() => {
    const update = () => setPosition(popoverPosition(anchor));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [anchor]);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    element.setAttribute('popover', 'auto');
    const native = typeof element.showPopover === 'function';
    if (native) { try { element.showPopover(); } catch { /* already open */ } }
    const toggle = (event: Event) => {
      if ((event as Event & { newState?: string }).newState === 'closed') onClose();
    };
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
    element.addEventListener('toggle', toggle);
    document.addEventListener('keydown', escape, true);
    if (!native) document.addEventListener('pointerdown', outside, true);
    return () => {
      element.removeEventListener('toggle', toggle);
      document.removeEventListener('keydown', escape, true);
      if (!native) document.removeEventListener('pointerdown', outside, true);
      if (native) { try { element.hidePopover(); } catch { /* already closed */ } }
    };
  }, [anchor, onClose]);
  useEffect(() => {
    if (!pinned) return;
    const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('[data-session-item]:not(:disabled)')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [pinned]);
  const move = (direction: 1 | -1) => {
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[data-session-item]:not(:disabled)') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + direction + items.length) % items.length]!.focus();
  };
  return <div ref={root} className="taskmd-session-popover" role="dialog" aria-label={`选择会话：${taskTitle}`}
    style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
    onMouseEnter={onEnter} onMouseLeave={onLeave}
    onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    }}>
    <div className="taskmd-session-popover-head">
      <span className="taskmd-session-popover-title" title={taskTitle}>{taskTitle}</span>
      <span className="taskmd-muted">{bindings.length}</span>
      <button type="button" className="taskmd-search-clear" aria-label="关闭会话列表" onClick={() => onClose(true)}>×</button>
    </div>
    {bindings.map(binding => {
      const status = statuses.get(binding.sessionId);
      const level = status ? levelOf(status) : 'idle';
      const archived = !!status?.archived;
      return <button type="button" key={binding.sessionId} data-session-item
        className="taskmd-session-popover-item" disabled={archived}
        title={archived ? '该 Session 已归档，请先在 DSH 会话列表中恢复' : binding.sessionId}
        onClick={() => onOpen(binding.sessionId)}>
        <span className={`taskmd-session-dot is-${level}`} aria-hidden="true" />
        <span className="taskmd-session-popover-name">{sessionTitle(binding.sessionId, status)}</span>
        <span className="taskmd-session-popover-meta">{archived ? '已归档' : status ? levelLabels[level] : '读取中…'}</span>
      </button>;
    })}
    {!bindings.length && <p className="taskmd-session-popover-empty">该任务还没有关联会话。</p>}
  </div>;
}
