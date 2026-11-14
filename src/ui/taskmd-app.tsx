import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { State, Task, TaskRecord, TaskSessionBinding, TaskStatus } from '../types.js';
import type { SessionCapability, SessionStatus, SessionStatusSource, TaskGraphPort } from './port.js';
import { compareTasks, descendants, failure, progress, statusLabels, useTasks } from './shared.js';
import { agentView, chipLabel, formatTokens, levelLabels, levelOf, relativeActivity, type AgentLevel, type TaskAgentView } from './agent-status.js';
import { TaskOutline } from './task-outline.js';
import { TaskEditor } from './task-editor.js';
import { TaskProperties } from './task-properties.js';
import { TaskAssets } from './task-assets.js';
import { TaskGraph } from './task-graph.js';
import { TaskSessionLauncher } from './session-launcher.js';
import { CopySessionId } from './copy-session-id.js';
import { styles } from './styles.js';
import { isString, useStored } from './view-state.js';

const taskStatusLabels: Record<TaskStatus, string> = {
  todo: '待办', in_progress: '进行中', done: '已完成', canceled: '已取消',
};

export interface TaskmdAppProps {
  port: TaskGraphPort;
  sessions?: SessionCapability;
  initialTaskId?: string;
  sessionId?: string;
  onOpenTask?(id: string): void;
  /** One-shot request from the DSH left sidebar: select this Task and unfold its launcher. */
  openTask?: { taskId: string; nonce: number };
  /** Confirms the host consumed the request, so a later panel mount does not replay it. */
  onOpenTaskHandled?(nonce: number): void;
}

/** Narrow view switches between the list and the detail instead of squeezing two columns. */
function useNarrow(ref: { current: HTMLElement | null }): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => { setNarrow(entries[0]!.contentRect.width < 900); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

/** One Task's merged agent view; `undefined` while bindings or statuses load. */
function useTaskAgentView(sessions: SessionCapability | undefined, taskId: string): TaskAgentView | undefined {
  const [bindings, setBindings] = useState<TaskSessionBinding[]>();
  const [tick, setTick] = useState(0);
  const statusSource = sessions?.statuses?.();
  useEffect(() => {
    if (!statusSource) return;
    return statusSource.subscribe(() => setTick(value => value + 1));
  }, [statusSource]);
  useEffect(() => {
    if (!sessions) return;
    const controller = new AbortController();
    void sessions.list(taskId, controller.signal)
      .then(value => { if (!controller.signal.aborted) setBindings(value); })
      .catch(() => { if (!controller.signal.aborted) setBindings(undefined); });
    return () => controller.abort();
  }, [sessions, taskId]);
  return useMemo(() => {
    if (!bindings || !statusSource) return undefined;
    const statuses = statusSource.get();
    return agentView(bindings
      .map(binding => statuses.get(binding.sessionId))
      .filter((status): status is SessionStatus => !!status));
  }, [bindings, statusSource, tick]);
}

/**
 * Every binding on this machine merged with live session status, so the whole
 * outline, the header pills and the filters share one view. Binding reads are
 * refreshed by the same invalidation bus the task graph uses.
 */
export function useAgentBindings(sessions: SessionCapability | undefined, port: TaskGraphPort) {
  const [bindings, setBindings] = useState<TaskSessionBinding[]>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [tick, setTick] = useState(0);
  const statusSource = sessions?.statuses?.();
  useEffect(() => port.subscribe(() => setReload(value => value + 1)), [port]);
  useEffect(() => {
    if (!statusSource) return;
    return statusSource.subscribe(() => setTick(value => value + 1));
  }, [statusSource]);
  useEffect(() => {
    if (!sessions) return;
    const controller = new AbortController();
    setLoaded(false);
    void sessions.list(undefined, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return;
        setBindings(value);
        setError('');
        setLoaded(true);
      })
      .catch(reason => {
        if (controller.signal.aborted) return;
        setBindings(undefined);
        setError(failure(reason));
        setLoaded(false);
      });
    return () => controller.abort();
  }, [sessions, reload]);
  const statuses = useMemo(() => statusSource?.get() ?? new Map<string, SessionStatus>(), [statusSource, tick]);
  const bindingsByTask = useMemo(() => {
    const map = new Map<string, TaskSessionBinding[]>();
    for (const binding of bindings ?? []) {
      const list = map.get(binding.taskId) ?? [];
      list.push(binding);
      map.set(binding.taskId, list);
    }
    for (const list of map.values()) list.sort(compareBindings);
    return map;
  }, [bindings]);
  const views = useMemo(() => {
    const map = new Map<string, TaskAgentView>();
    if (!bindings || !statusSource) return map;
    const byTask = new Map<string, SessionStatus[]>();
    for (const binding of bindings) {
      const status = statuses.get(binding.sessionId);
      if (!status) continue; // The catalog is not ready for this id yet.
      const list = byTask.get(binding.taskId) ?? [];
      list.push(status);
      byTask.set(binding.taskId, list);
    }
    for (const [taskId, list] of byTask) map.set(taskId, agentView(list));
    return map;
  }, [bindings, statusSource, statuses]);
  const totals = useMemo(() => {
    let attention = 0, running = 0, fresh = 0;
    for (const view of views.values()) { attention += view.attention; running += view.running; fresh += view.fresh; }
    return { attention, running, fresh };
  }, [views]);
  return { views, totals, enabled: !!statusSource && !!sessions, bindings, bindingsByTask, statuses, error, loaded };
}

/** Rolls every descendant's sessions into one view for parent rows and pills. */
export function subtreeViews(tasks: Task[] | undefined, views: Map<string, TaskAgentView>): Map<string, TaskAgentView> {
  const map = new Map<string, TaskAgentView>();
  if (!tasks?.length || views.size === 0) return map;
  for (const task of tasks) {
    const merged: SessionStatus[] = [];
    for (const id of descendants(tasks, task.id)) merged.push(...(views.get(id)?.statuses ?? []));
    if (merged.length) map.set(task.id, agentView(merged));
  }
  return map;
}

export function TaskmdApp({ port, sessions, initialTaskId, sessionId, onOpenTask, openTask, onOpenTaskHandled }: TaskmdAppProps) {
  const { state, error, refresh } = useTasks(port);
  // Selection, view, width and filters survive leaving the panel or reloading the page.
  const [selected, setSelected] = useStored<string | undefined>('selected', initialTaskId,
    (value): value is string | undefined => value === undefined || isString(value));
  const [view, setView] = useStored<'outline' | 'graph'>('view', 'outline',
    (value): value is 'outline' | 'graph' => value === 'outline' || value === 'graph');
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useStored('repo', '', isString);
  const [archived, setArchived] = useStored('archived', false, (value): value is boolean => typeof value === 'boolean');
  type Filter = 'all' | 'ready' | 'progress' | 'agent';
  const [filter, setFilter] = useStored<Filter>('filter', 'all',
    (value): value is Filter => value === 'all' || value === 'ready' || value === 'progress' || value === 'agent');
  const [pane, setPane] = useStored<'list' | 'detail'>('pane', 'list',
    (value): value is 'list' | 'detail' => value === 'list' || value === 'detail');
  const [dirty, setDirty] = useState(false);
  const [split, setSplit] = useStored('split', 58,
    (value): value is number => typeof value === 'number' && value >= 30 && value <= 80);
  const columns = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(root);
  const agent = useAgentBindings(sessions, port);
  const [jump, setJump] = useState<{ id: string; nonce: number }>();
  const [launch, setLaunch] = useState<{ taskId: string; nonce: number }>();
  const handledOpen = useRef(0);
  // Only an explicit prop overrides the remembered selection.
  useEffect(() => { if (initialTaskId !== undefined) setSelected(initialTaskId); }, [initialTaskId, setSelected]);
  // The DSH left sidebar's no-session path arrives while this panel may be
  // unmounted; the plugin-level signal survives that gap. A nonce keeps an
  // ordinary re-render (or a later panel mount) from replaying the request.
  useEffect(() => {
    if (!openTask || openTask.nonce === handledOpen.current) return;
    handledOpen.current = openTask.nonce;
    if (dirty && !window.confirm('当前修改尚未保存。要切换任务吗？未保存草稿会保留在本会话存储中。')) {
      onOpenTaskHandled?.(openTask.nonce);
      return;
    }
    setDirty(false);
    setSelected(openTask.taskId);
    setPane('detail');
    setLaunch({ taskId: openTask.taskId, nonce: openTask.nonce });
    onOpenTaskHandled?.(openTask.nonce);
  }, [openTask, dirty, setSelected, setPane, onOpenTaskHandled]);
  const ready = useMemo(() => new Set(state?.ready || []), [state]);
  const subtree = useMemo(() => subtreeViews(state?.tasks, agent.views), [state, agent.views]);
  const jumpTo = (level: 'attention' | 'running' | 'fresh') => {
    if (!state) return;
    const target = [...state.tasks].sort(compareTasks).find(task => (subtree.get(task.id)?.[level] ?? 0) > 0);
    if (!target) return;
    setJump({ id: target.id, nonce: (jump?.nonce ?? 0) + 1 });
    choose(target.id);
  };
  const repos = useMemo(() => [...new Set((state?.tasks || []).map(task => task.repo).filter((name): name is string => !!name))].sort(), [state]);
  const tasks = useMemo(() => {
    const search = query.toLocaleLowerCase();
    return (state?.tasks || []).filter(task => (archived || !task.archived)
      && (!repo || task.repo === repo)
      && (filter === 'all'
        || (filter === 'ready' ? ready.has(task.id)
          : filter === 'progress' ? task.status === 'in_progress'
            : (subtree.get(task.id)?.active ?? 0) > 0))
      && (!search || `${task.title} ${task.id} ${task.repo || ''}`.toLocaleLowerCase().includes(search)));
  }, [state, archived, repo, filter, subtree, query, ready]);
  const current = state?.tasks.find(task => task.id === selected);
  useEffect(() => {
    if (state && selected && !current) { setSelected(undefined); setDirty(false); setPane('list'); }
  }, [state, selected, current]);
  const choose = (id: string) => {
    if (selected === id && !(narrow && pane === 'list')) return;
    if (dirty && !window.confirm('当前修改尚未保存。要切换任务吗？未保存草稿会保留在本会话存储中。')) return;
    if (initialTaskId !== undefined && onOpenTask) { onOpenTask(id); return; }
    setLaunch(undefined);
    setDirty(false); setSelected(id); if (narrow) setPane('detail');
  };
  return <div className="taskmd-app" ref={root} data-pane={narrow ? pane : 'wide'}>
    <style>{styles}</style>
    <header className="taskmd-header"><h2>任务</h2><span className="taskmd-muted">{state?.tasks.length ?? '…'} 项</span>
      {agent.enabled && <div className="taskmd-agent-bar" role="group" aria-label="Agent 执行状态">
        <AgentPill level="attention" count={agent.totals.attention} onJump={jumpTo} />
        <AgentPill level="running" count={agent.totals.running} onJump={jumpTo} />
        <AgentPill level="fresh" count={agent.totals.fresh} onJump={jumpTo} />
      </div>}
      {narrow && <div className="taskmd-pane-toggle" role="tablist">
        <button role="tab" aria-selected={pane === 'list'} onClick={() => setPane('list')}>列表</button>
        <button role="tab" aria-selected={pane === 'detail'} onClick={() => setPane('detail')}>详情</button>
      </div>}
      <button aria-label="刷新任务列表" title="刷新任务列表" onClick={() => { void refresh(); }}>↻</button>
      <div className="taskmd-view-toggle">
        <button aria-pressed={view === 'outline'} onClick={() => setView('outline')}>大纲</button>
        <button aria-pressed={view === 'graph'} onClick={() => setView('graph')}>关系图</button>
      </div>
    </header>
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    <div className="taskmd-columns" ref={columns} style={{ '--tm-left': `${split}fr`, '--tm-right': `${100 - split}fr` } as CSSProperties}>
      <section className="taskmd-main" aria-label="任务大纲">
        <div className="taskmd-filters" aria-label="任务筛选">
          <input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)} />
          <div className="taskmd-filter-chips" role="group" aria-label="状态筛选">
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
            <button aria-pressed={filter === 'ready'} onClick={() => setFilter('ready')}>待办 · {ready.size}</button>
            <button aria-pressed={filter === 'progress'} onClick={() => setFilter('progress')}>进行中</button>
            {agent.enabled && <button aria-pressed={filter === 'agent'} onClick={() => setFilter('agent')}>Agent 活动</button>}
          </div>
          <label className="taskmd-repo-filter"><select aria-label="按仓库筛选" value={repo} onChange={event => setRepo(event.target.value)}>
            <option value="">全部仓库</option>{repos.map(name => <option key={name} value={name}>{name}</option>)}
          </select></label>
          <details className="taskmd-more-filters"><summary aria-label="更多筛选">⋯</summary><div>
            <label className="taskmd-check"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />包含归档</label>
          </div></details>
        </div>
        {!!state?.diagnostics.length && <details className="taskmd-box"><summary>校验信息（{state.diagnostics.length}）</summary>
          <ul>{state.diagnostics.map((item, index) => <li key={index} className={item.severity === 'error' ? 'taskmd-error' : ''}>
            {item.taskId && <button onClick={() => choose(item.taskId!)}>{item.taskId}</button>} {item.code}: {item.message}
          </li>)}</ul></details>}

        {view === 'graph' && state ? <TaskGraph tasks={tasks} ready={state.ready} selected={selected} onSelect={choose} state={state} />
          : state ? <TaskOutline tasks={tasks} state={state} selected={selected} port={port} onSelect={choose} onChanged={refresh}
            agent={agent.enabled ? subtree : undefined} reveal={jump} />
            : <p className="taskmd-muted">正在加载任务…</p>}
      </section>
      {!narrow && <div className="taskmd-divider" role="separator" aria-label="调整大纲与详情宽度" aria-orientation="vertical"
        aria-valuemin={30} aria-valuemax={80} aria-valuenow={split} tabIndex={0}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId) || !columns.current) return;
          const rect = columns.current.getBoundingClientRect();
          const width = rect.width - event.currentTarget.offsetWidth;
          if (width > 0) setSplit(Math.max(30, Math.min(80, Math.round((event.clientX - rect.left - event.currentTarget.offsetWidth / 2) / width * 100))));
        }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          setSplit(value => event.key === 'Home' ? 30 : event.key === 'End' ? 80 : Math.max(30, Math.min(80, value + (event.key === 'ArrowLeft' ? -2 : 2))));
        }} onDoubleClick={() => setSplit(58)} />}
      <section className="taskmd-details" aria-label="任务详情">
        {state && selected ? <TaskDetail key={selected} id={selected} port={port} state={state} task={current}
          sessions={sessions} sessionId={sessionId} agent={agent.views.get(selected)} onSelect={choose} onChanged={refresh} onDirty={setDirty}
          launchTask={launch?.taskId === selected ? launch.nonce : undefined}
          /> : <p className="taskmd-muted">选择一个任务，查看详情和关联会话。</p>}
      </section>
    </div>
  </div>;
}

/** Compact detail for the DSH right sidebar; never embeds the full two-column app. */
export function TaskmdDetailPanel({ port, sessions, sessionId, taskId, onOpenTask }: {
  port: TaskGraphPort; sessions?: SessionCapability; sessionId?: string; taskId: string; onOpenTask?(id: string): void;
}) {
  const { state, error, refresh } = useTasks(port);
  const task = state?.tasks.find(item => item.id === taskId);
  const agent = useTaskAgentView(sessions, taskId);
  return <div className="taskmd-app taskmd-detail-panel"><style>{styles}</style>
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    {state ? <TaskDetail key={taskId} id={taskId} port={port} state={state} task={task} sessions={sessions} sessionId={sessionId}
      agent={agent} onSelect={id => onOpenTask?.(id)} onChanged={refresh} onDirty={() => {}} compact /> : <p className="taskmd-muted">正在加载任务…</p>}
  </div>;
}

function TaskDetail({ id, port, state, task, sessions, sessionId, agent, onSelect, onChanged, onDirty, launchTask, compact = false }: {
  id: string; port: TaskGraphPort; state: State; task?: Task; sessions?: SessionCapability; sessionId?: string;
  agent?: TaskAgentView;
  onSelect(id: string): void; onChanged(): Promise<void>; onDirty(dirty: boolean): void;
  /** A DSH left-sidebar open signal: unfold this Task's launcher once per nonce. */
  launchTask?: number;
  /** Right-sidebar presentation: status first, dense sections, fold the long body. */
  compact?: boolean;
}) {
  const [record, setRecord] = useState<TaskRecord>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [editorDirty, setEditorDirty] = useState(false);
  const [propertiesDirty, setPropertiesDirty] = useState(false);
  const draftPending = editorDirty || propertiesDirty;
  const active = useRef(true);
  const statusLock = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { onDirty(editorDirty || propertiesDirty); return () => onDirty(false); }, [editorDirty, propertiesDirty, onDirty]);
  useEffect(() => {
    const controller = new AbortController();
    if (!task) { setRecord(undefined); return; }
    void port.readTask(id, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      setRecord(next); setReadError('');
    }).catch(error => { if (!controller.signal.aborted) setReadError(failure(error)); });
    return () => controller.abort();
  }, [id, port, state.revision, reload]);
  const displayed = task || record?.task;
  const count = displayed ? progress(state.tasks, displayed.id) : { total: 0, done: 0, canceled: 0, terminal: 0 };
  const canArchive = !!record && !!displayed && !displayed.archived;
  const archiveTitle = draftPending ? '先保存或放弃正文、属性草稿' : undefined;
  const canStart = !!record && !!displayed && displayed.status === 'todo' && !busy;
  const canComplete = !!record && !!displayed &&
    (displayed.status === 'todo' || displayed.status === 'in_progress') && !busy;
  const canReopen = !!record && !!displayed &&
    (displayed.status === 'done' || displayed.status === 'canceled') && !busy;
  const statusOptionDisabled = (_value: TaskStatus): boolean => !record || busy;
  // One writer for every visible status transition; graph rules still validate it.
  const changeStatus = async (next: TaskStatus) => {
    if (!record || !displayed || busy || statusLock.current || next === displayed.status) return;
    statusLock.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      await port.apply({ requestId: crypto.randomUUID(), baseRevision: state.revision,
        operations: [{ op: 'patch', id, expectedVersion: record.version, changes: { status: next } }] });
      await onChanged();
    } catch (error) { if (active.current) setError(failure(error)); }
    finally { statusLock.current = false; if (active.current) setBusy(false); }
  };
  // Archive and restore are reversible, so they happen on one click; delete
  // stays in the properties panel with its explicit confirmation.
  const changeArchive = async (op: 'archive' | 'restore') => {
    if (!record || !displayed || busy || statusLock.current) return;
    statusLock.current = true;
    setBusy(true); setError(''); setNotice('');
    try {
      await port.apply({ requestId: crypto.randomUUID(), baseRevision: state.revision,
        operations: [{ op: 'patch', id, changes: {}, expectedVersion: record.version }, { op, id }] });
      if (active.current) setNotice(op === 'archive' ? '任务已归档，默认从大纲中隐藏。' : '已取消归档，执行状态保持不变。');
      await onChanged();
    } catch (error) { if (active.current) setError(failure(error)); }
    finally { statusLock.current = false; if (active.current) setBusy(false); }
  };
  // One status control for both layouts: the compact header and the wide
  // summary render the same select, so todo/in-progress tasks stay editable.
  const statusControl = displayed && !displayed.archived
    ? <span className="taskmd-status-wrap">
      <select aria-label="任务状态" title="编辑任务状态" className={`taskmd-status-select is-${displayed.status}`}
        value={displayed.status} disabled={!record || busy}
        onChange={event => {
          const next = event.target.value as TaskStatus;
          if (statusOptionDisabled(next)) { event.currentTarget.value = displayed.status; return; }
          void changeStatus(next);
        }}>
        {(['todo', 'in_progress', 'done', 'canceled'] as TaskStatus[]).map(value =>
          <option key={value} value={value} disabled={statusOptionDisabled(value)}>{taskStatusLabels[value]}</option>)}
      </select>
    </span>
    : undefined;
  if (!task) return <p className="taskmd-muted">任务不存在或已删除。</p>;
  const crumb: Task[] = [];
  for (let cursor = state.tasks.find(item => item.id === displayed?.parent); cursor && crumb.length < 4;) {
    crumb.unshift(cursor);
    const parent: string | null = cursor.parent;
    cursor = parent ? state.tasks.find(item => item.id === parent) : undefined;
  }
  return <div className={`taskmd-task-detail${compact ? ' is-compact' : ''}`}>
    {!!crumb.length && <div className="taskmd-detail-crumb">
      {crumb.map(item => <span key={item.id}><button onClick={() => onSelect(item.id)}>{item.title}</button> › </span>)}
    </div>}
    {compact ? <header className="taskmd-panel-head">
      <h3 className="taskmd-detail-title" title={id}>{displayed?.title || id}</h3>
      <div className="taskmd-panel-actions">
        {statusControl}
        {displayed?.archived && <span className="taskmd-badge">已归档 · {taskStatusLabels[displayed.status]}</span>}
        {canStart && <button type="button" className="taskmd-primary-action" disabled={busy} onClick={() => { void changeStatus('in_progress'); }}>标记进行中</button>}
        {!canStart && canComplete && <button type="button" className="taskmd-primary-action" disabled={busy} onClick={() => { void changeStatus('done'); }}>标记完成</button>}
        {!canStart && !canComplete && canReopen && <button type="button" className="taskmd-primary-action is-secondary" disabled={busy} onClick={() => { void changeStatus('todo'); }}>标记待办</button>}
        {displayed && !displayed.archived && <button type="button" className="taskmd-secondary-action"
          disabled={busy || draftPending || !canArchive} title={archiveTitle} onClick={() => { void changeArchive('archive'); }}>归档</button>}
        {displayed?.archived && <button type="button" className="taskmd-secondary-action"
          disabled={busy || draftPending || !record} title={draftPending ? '先保存或放弃正文、属性草稿' : undefined}
          onClick={() => { void changeArchive('restore'); }}>取消归档</button>}
      </div>
      <div className="taskmd-panel-meta">
        {displayed?.repo && <span>{displayed.repo}</span>}
        {!!count.total && <span className="taskmd-panel-progress" title={`子任务 ${count.done}/${count.total} 完成`}>
          <i style={{ '--p': `${Math.round(count.done / count.total * 100)}%` } as CSSProperties} />{count.done}/{count.total}
        </span>}
      </div>
    </header> : <>
      <h3 className="taskmd-detail-title">{displayed?.title || id}</h3>
      <div className="taskmd-detail-meta taskmd-muted"><span title={id}>{id}</span>{displayed?.repo && <span>{displayed.repo}</span>}</div>
    </>}
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    {notice && <p className="taskmd-notice" role="status">{notice}</p>}
    {readError && <p className="taskmd-error" role="alert">{readError} <button disabled={busy} onClick={() => setReload(value => value + 1)}>重试读取</button></p>}
    {displayed && <>
      {!compact && <div className="taskmd-detail-summary">
        {displayed.archived
          ? <span className={`taskmd-badge taskmd-status-${displayed.status}`}>{statusLabels[displayed.status]}</span>
          : statusControl}
        {displayed.archived && <span className="taskmd-badge">已归档</span>}
        {!!count.total && <span className="taskmd-muted">子任务 {count.done}/{count.total} 完成{count.canceled > 0 && ` · ${count.canceled} 取消`}</span>}
        {canStart && <button className="taskmd-primary-action" disabled={busy} onClick={() => { void changeStatus('in_progress'); }}>标记进行中</button>}
        {!canStart && canComplete && <button className="taskmd-primary-action" disabled={busy} onClick={() => { void changeStatus('done'); }}>标记完成</button>}
        {!canStart && !canComplete && canReopen && <button className="taskmd-primary-action is-secondary" disabled={busy} onClick={() => { void changeStatus('todo'); }}>标记待办</button>}
        {!displayed.archived && <button className="taskmd-secondary-action" disabled={busy || draftPending || !canArchive}
          title={archiveTitle} onClick={() => { void changeArchive('archive'); }}>归档</button>}
        {displayed.archived && <button className="taskmd-secondary-action" disabled={busy || draftPending || !record}
          title={draftPending ? '先保存或放弃正文、属性草稿' : undefined} onClick={() => { void changeArchive('restore'); }}>取消归档</button>}
      </div>}
      {sessions && <TaskExecution key={id} task={displayed} capability={sessions} port={port} currentSessionId={sessionId}
        agent={agent} startBusy={busy} onStart={() => { void changeStatus('in_progress'); }} launchTask={launchTask} compact={compact} />}
      {record && <TaskProperties task={displayed} record={record} port={port} state={state} onChanged={onChanged} onSelect={onSelect} onDirty={setPropertiesDirty} bodyDirty={editorDirty} compact={compact} />}
      {record && <TaskEditor record={record} port={port} state={state} onChanged={onChanged} onDirty={setEditorDirty} compact={compact} />}
      {record && <TaskAssets record={record} state={state} port={port} onChanged={onChanged} />}
    </>}
  </div>;
}

/** Compact local time for a binding timestamp; unparseable values stay visible instead of "Invalid Date". */
function bindingTimeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value
    : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Last opened first; missing `lastOpenedAt` falls back to `createdAt`, then session id for stability. */
export function compareBindings(a: TaskSessionBinding, b: TaskSessionBinding): number {
  const at = a.lastOpenedAt ?? a.createdAt, bt = b.lastOpenedAt ?? b.createdAt;
  return at !== bt ? at < bt ? 1 : -1 : a.sessionId.localeCompare(b.sessionId);
}

/** One header pill: a count of sessions in one state; clicking jumps to the first owning Task. */
function AgentPill({ level, count, onJump }: {
  level: 'attention' | 'running' | 'fresh'; count: number; onJump(level: 'attention' | 'running' | 'fresh'): void;
}) {
  const label = level === 'attention' ? '等你处理' : level === 'running' ? '运行中' : '新结果';
  const glyph = level === 'attention' ? '⚠' : level === 'running' ? '●' : '✓';
  return <button className={`taskmd-agent-pill is-${level}`} disabled={count === 0} title={count ? `跳到第一个「${label}」的任务` : `没有${label}的会话`}
    onClick={() => onJump(level)}>
    <span className="taskmd-agent-glyph" aria-hidden="true">{glyph}</span>{count} {label}
  </button>;
}

const badgeGlyphs: Record<AgentLevel, string> = {
  attention: '⚠', running: '●', fresh: '✓', idle: '○', blank: '·', archived: '▤', missing: '✕',
};

/** Session rows under one Task, with live state, soft hints and the launcher folded in. */
function TaskExecution({ task, capability, port, currentSessionId, agent, startBusy, onStart, launchTask, compact = false }: {
  task: Task; capability: SessionCapability; port: TaskGraphPort; currentSessionId?: string;
  agent?: TaskAgentView; startBusy: boolean; onStart(): void; launchTask?: number; compact?: boolean;
}) {
  const taskId = task.id;
  const [bindings, setBindings] = useState<TaskSessionBinding[]>();
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [creating, setCreating] = useState(launchTask !== undefined);
  const [bindOpen, setBindOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const statusSource = capability.statuses?.();
  useEffect(() => { if (launchTask !== undefined) setCreating(true); }, [launchTask]);
  useEffect(() => port.subscribe(() => setReload(value => value + 1)), [port]);
  useEffect(() => {
    if (!statusSource) return;
    return statusSource.subscribe(() => setTick(value => value + 1));
  }, [statusSource]);
  useEffect(() => {
    const controller = new AbortController();
    void capability.list(taskId, controller.signal).then(value => {
      if (!controller.signal.aborted) { setBindings([...value].sort(compareBindings)); setListError(''); }
    }).catch(error => { if (!controller.signal.aborted) setListError(failure(error)); });
    return () => controller.abort();
  }, [capability, taskId, reload]);
  const rows = useMemo(() => {
    if (!bindings) return undefined;
    const statuses = statusSource?.get();
    return bindings.map(binding => ({ binding, status: statuses?.get(binding.sessionId) }));
  }, [bindings, statusSource, tick]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); setReload(value => value + 1); }
    catch (error) { setError(failure(error)); }
    finally { setBusy(false); }
  };
  const freshSession = agent?.statuses.find(status => status.fresh);
  return <section className={`taskmd-box taskmd-execution${compact ? ' is-compact' : ''}`} aria-label="执行">
    <div className="taskmd-execution-head">
      <h4>{compact ? '会话' : '执行'}{(rows?.length ?? 0) > 0 ? ` · ${rows!.length}` : ''}</h4>
      <div className="taskmd-execution-actions">
        <button className="taskmd-new-session" aria-expanded={creating} onClick={() => setCreating(value => !value)}>＋ 新会话</button>
        <button type="button" className="taskmd-bind-toggle" aria-expanded={bindOpen} aria-controls={`taskmd-bind-form-${taskId}`}
          onClick={() => setBindOpen(value => !value)}>{compact ? '关联已有' : '关联已有会话'}</button>
      </div>
    </div>
    {creating && <TaskSessionLauncher task={task} capability={capability} defaultOpen openNonce={launchTask} />}
    {bindOpen && <form id={`taskmd-bind-form-${taskId}`} className="taskmd-bind-form"
      onSubmit={event => {
        event.preventDefault();
        const target = sessionId.trim();
        if (!target) return;
        void run(async () => { await capability.bind(taskId, target); setSessionId(''); setBindOpen(false); });
      }}>
      <label>会话 ID<input value={sessionId} onChange={event => setSessionId(event.target.value)} placeholder="会话 ID" /></label>
      <button disabled={busy || !sessionId.trim()}>关联</button>
    </form>}
    {error && <p role="alert" className="taskmd-error">{error}</p>}
    {listError && <p role="alert" className="taskmd-error">{listError} <button onClick={() => setReload(value => value + 1)}>重试</button></p>}
    {freshSession && <p className="taskmd-agent-hint is-fresh" role="status">
      {compact ? '有新结果' : '有会话已出结果，还没查看。'}<button disabled={busy} onClick={() => { void run(() => capability.open(freshSession.sessionId)); }}>{compact ? '查看' : '查看会话'}</button>
    </p>}
    {!!rows?.length && <ul className="taskmd-sessions">{rows.map(({ binding, status }) => {
      const level = status ? levelOf(status) : undefined;
      const meta = [
        status?.agentPreset,
        status?.runningSubagents ? `${status.runningSubagents} 个子 agent 运行` : '',
        status?.tokens !== undefined ? `${formatTokens(status.tokens)} tokens` : '',
        binding.lastOpenedAt ? `最近打开 ${bindingTimeLabel(binding.lastOpenedAt)}` : `创建于 ${bindingTimeLabel(binding.createdAt)}`,
      ].filter(Boolean).join(' · ');
      return <li key={binding.sessionId} className={`taskmd-session-row${compact ? ' is-compact' : ''}`}>
        {level && <span className={`taskmd-agent-badge is-${level}`} role="img" aria-label={levelLabels[level]} title={levelLabels[level]}>{badgeGlyphs[level]}</span>}
        <button className="taskmd-session-open" disabled={busy} title={status?.title ? `${status.title}\n${binding.sessionId}` : binding.sessionId}
          onClick={() => { void run(() => capability.open(binding.sessionId)); }}>
          {status?.title || binding.sessionId}
          {status && <small>{levelLabels[levelOf(status)]}{status.updatedAt !== undefined && !status.running ? ` · ${relativeActivity(status, Date.now())}前活跃` : ''}</small>}
        </button>
        {compact
          ? <details className="taskmd-session-menu taskmd-row-menu"><summary aria-label="会话操作">⋯</summary><div>
            <CopySessionId sessionId={binding.sessionId} />
            <button disabled={busy} onClick={() => { void run(() => capability.unbind(taskId, binding.sessionId)); }}>解除关联</button>
          </div></details>
          : <>
            <span className="taskmd-session-meta taskmd-muted">{meta}</span>
            <CopySessionId sessionId={binding.sessionId} />
            <button disabled={busy} onClick={() => { void run(() => capability.unbind(taskId, binding.sessionId)); }}>解除关联</button>
          </>}
      </li>;
    })}</ul>}
    {rows !== undefined && rows.length === 0 && <p className="taskmd-muted">{compact ? '暂无会话' : '此任务还没有关联会话。'}</p>}
    {rows === undefined && !listError && <p className="taskmd-muted">{compact ? '读取中…' : '正在读取关联会话…'}</p>}
    {currentSessionId && !(bindings || []).some(binding => binding.sessionId === currentSessionId) && <button className={compact ? 'taskmd-quiet' : undefined} disabled={busy} onClick={() => { void run(() => capability.bind(taskId, currentSessionId)); }}>关联当前会话</button>}
  </section>;
}

export function TaskmdSidebar({ port, sessions, sessionId, onOpenTask }: {
  port: TaskGraphPort; sessions?: SessionCapability; sessionId: string; onOpenTask(id: string): void;
}) {
  const { state, error, refresh } = useTasks(port);
  const [bindings, setBindings] = useState<TaskSessionBinding[]>([]);
  const [selected, setSelected] = useState('');
  const [actionError, setActionError] = useState('');
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => port.subscribe(() => setReload(value => value + 1)), [port]);
  useEffect(() => {
    if (!sessions) return;
    const controller = new AbortController();
    void sessions.list(undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) {
        setBindings(value.filter(binding => binding.sessionId === sessionId));
        setListError('');
      }
    }).catch(error => { if (!controller.signal.aborted) setListError(failure(error)); });
    return () => controller.abort();
  }, [sessions, sessionId, reload]);
  const mutate = async (id: string, remove: boolean) => {
    if (!sessions || busy) return;
    setBusy(true); setActionError('');
    try {
      if (remove) await sessions.unbind(id, sessionId); else await sessions.bind(id, sessionId);
      setReload(value => value + 1); await refresh();
    } catch (error) { setActionError(failure(error)); }
    finally { setBusy(false); }
  };
  const linked = new Set(bindings.map(binding => binding.taskId));
  return <section className="taskmd-app taskmd-session-sidebar"><style>{styles}</style><h3>本会话任务 <span className="taskmd-muted">{bindings.length}</span></h3>
    {(error || actionError) && <p className="taskmd-error" role="alert">{error || actionError}</p>}
    {listError && <p className="taskmd-error" role="alert">{listError} <button onClick={() => setReload(value => value + 1)}>重试</button></p>}
    <ul className="taskmd-tree">{bindings.map(binding => {
      const task = state?.tasks.find(task => task.id === binding.taskId);
      return <li key={binding.taskId}>
        <span className={`taskmd-status-dot is-${task?.status ?? 'todo'}`} role="img"
          aria-label={task ? statusLabels[task.status] : '任务不可用'} />
        <button onClick={() => onOpenTask(binding.taskId)}><strong>{task?.title || binding.taskId}</strong><small>{task ? statusLabels[task.status] : '任务不可用'}</small></button>
        <button disabled={busy} aria-label={`解除关联 ${task?.title || binding.taskId}`} onClick={() => { void mutate(binding.taskId, true); }}>解除关联</button></li>;
    })}</ul>
    {bindings.length === 0 && <p className="taskmd-muted">当前会话尚未关联任务。</p>}
    {sessions && <form onSubmit={event => { event.preventDefault(); if (selected) void mutate(selected, false); }}>
      <label>关联任务<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">选择任务</option>
        {state?.tasks.filter(task => !linked.has(task.id) && !task.archived).sort(compareTasks).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select></label><button disabled={busy || !selected}>关联当前会话</button></form>}
  </section>;
}
