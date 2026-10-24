import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { State, Task, TaskRecord, TaskSessionBinding } from '../types.js';
import type { SessionCapability, TaskGraphPort } from './port.js';
import { executionBlockers } from '../core/graph.js';
import { compareTasks, failure, progress, statusLabels, useTasks } from './shared.js';
import { TaskOutline } from './task-outline.js';
import { TaskEditor } from './task-editor.js';
import { TaskProperties } from './task-properties.js';
import { TaskAssets } from './task-assets.js';
import { TaskGraph } from './task-graph.js';
import { TaskSessionLauncher } from './session-launcher.js';
import { CopySessionId } from './copy-session-id.js';
import { styles } from './styles.js';

export interface TaskmdAppProps {
  port: TaskGraphPort;
  sessions?: SessionCapability;
  initialTaskId?: string;
  sessionId?: string;
  onOpenTask?(id: string): void;
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

export function TaskmdApp({ port, sessions, initialTaskId, sessionId, onOpenTask }: TaskmdAppProps) {
  const { state, error, refresh } = useTasks(port);
  const [selected, setSelected] = useState(initialTaskId);
  const [view, setView] = useState<'outline' | 'graph'>('outline');
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('');
  const [archived, setArchived] = useState(false);
  const [readyOnly, setReadyOnly] = useState(false);
  const [pane, setPane] = useState<'list' | 'detail'>('list');
  const [dirty, setDirty] = useState(false);
  const [split, setSplit] = useState(70);
  const columns = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(root);
  useEffect(() => { setSelected(initialTaskId); }, [initialTaskId]);
  const ready = useMemo(() => new Set(state?.ready || []), [state]);
  const repos = useMemo(() => [...new Set((state?.tasks || []).map(task => task.repo).filter((name): name is string => !!name))].sort(), [state]);
  const tasks = useMemo(() => {
    const search = query.toLocaleLowerCase();
    return (state?.tasks || []).filter(task => (archived || !task.archived)
      && (!repo || task.repo === repo)
      && (!readyOnly || ready.has(task.id))
      && (!search || `${task.title} ${task.id} ${task.repo || ''}`.toLocaleLowerCase().includes(search)));
  }, [state, archived, repo, readyOnly, query, ready]);
  const current = state?.tasks.find(task => task.id === selected);
  useEffect(() => {
    if (state && selected && !current) { setSelected(undefined); setDirty(false); setPane('list'); }
  }, [state, selected, current]);
  const choose = (id: string) => {
    if (selected === id && !(narrow && pane === 'list')) return;
    if (dirty && !window.confirm('当前修改尚未保存。要切换任务吗？未保存草稿会保留在本会话存储中。')) return;
    if (initialTaskId !== undefined && onOpenTask) { onOpenTask(id); return; }
    setDirty(false); setSelected(id); if (narrow) setPane('detail');
  };
  return <div className="taskmd-app" ref={root} data-pane={narrow ? pane : 'wide'}>
    <style>{styles}</style>
    <header className="taskmd-header"><h2>任务</h2><span>{state?.tasks.length ?? '…'} 项</span>
      {narrow && <div className="taskmd-pane-toggle" role="tablist">
        <button role="tab" aria-selected={pane === 'list'} onClick={() => setPane('list')}>列表</button>
        <button role="tab" aria-selected={pane === 'detail'} onClick={() => setPane('detail')}>详情</button>
      </div>}
      <button onClick={() => { void refresh(); }}>刷新</button>
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
          <label className="taskmd-repo-filter"><select aria-label="按仓库筛选" value={repo} onChange={event => setRepo(event.target.value)}>
            <option value="">全部仓库</option>{repos.map(name => <option key={name} value={name}>{name}</option>)}
          </select></label>
          <button className={`taskmd-ready-entry${readyOnly ? ' is-active' : ''}`} aria-pressed={readyOnly}
            onClick={() => setReadyOnly(value => !value)}>可开始 · {ready.size}</button>
          <label className="taskmd-check"><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />包含归档</label>
        </div>
        {!!state?.diagnostics.length && <details className="taskmd-box"><summary>校验信息（{state.diagnostics.length}）</summary>
          <ul>{state.diagnostics.map((item, index) => <li key={index} className={item.severity === 'error' ? 'taskmd-error' : ''}>
            {item.taskId && <button onClick={() => choose(item.taskId!)}>{item.taskId}</button>} {item.code}: {item.message}
          </li>)}</ul></details>}

        {view === 'graph' && state ? <TaskGraph tasks={tasks} ready={state.ready} selected={selected} onSelect={choose} state={state} />
          : state ? <TaskOutline tasks={tasks} state={state} selected={selected} port={port} onSelect={choose} onChanged={refresh} />
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
        }} onDoubleClick={() => setSplit(70)} />}
      <section className="taskmd-details" aria-label="任务详情">
        {state && selected ? <TaskDetail key={selected} id={selected} port={port} state={state} task={current}
          sessions={sessions} sessionId={sessionId} onSelect={choose} onChanged={refresh} onDirty={setDirty}
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
  return <div className="taskmd-app taskmd-detail-panel"><style>{styles}</style>
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    {state ? <TaskDetail key={taskId} id={taskId} port={port} state={state} task={task} sessions={sessions} sessionId={sessionId}
      onSelect={id => onOpenTask?.(id)} onChanged={refresh} onDirty={() => {}} /> : <p className="taskmd-muted">正在加载任务…</p>}
  </div>;
}

function TaskDetail({ id, port, state, task, sessions, sessionId, onSelect, onChanged, onDirty }: {
  id: string; port: TaskGraphPort; state: State; task?: Task; sessions?: SessionCapability; sessionId?: string;
  onSelect(id: string): void; onChanged(): Promise<void>; onDirty(dirty: boolean): void;
}) {
  const [record, setRecord] = useState<TaskRecord>();
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [editorDirty, setEditorDirty] = useState(false);
  const [propertiesDirty, setPropertiesDirty] = useState(false);
  const active = useRef(true);
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
  const blockers = displayed?.status === 'todo' ? executionBlockers(state.tasks, displayed.id) : [];
  const count = displayed ? progress(state.tasks, displayed.id) : { total: 0, done: 0, canceled: 0, terminal: 0 };
  const finishable = !!displayed && count.total > 0 && count.terminal === count.total
    && (displayed.status === 'todo' || displayed.status === 'in_progress') && !displayed.archived && !!record && !busy;
  const finish = async () => {
    if (!record || !displayed || busy) return;
    setBusy(true); setError('');
    try {
      await port.apply({ requestId: crypto.randomUUID(), baseRevision: state.revision,
        operations: [{ op: 'patch', id, expectedVersion: record.version, changes: { status: 'done' } }] });
      await onChanged();
    } catch (error) { if (active.current) setError(failure(error)); }
    finally { if (active.current) setBusy(false); }
  };
  if (!task) return <p className="taskmd-muted">任务不存在或已删除。</p>;
  return <div className="taskmd-task-detail">
    <h3 className="taskmd-detail-title">{displayed?.title || id}</h3>
    <div className="taskmd-detail-meta taskmd-muted"><span title={id}>{id}</span>{displayed?.repo && <span>{displayed.repo}</span>}</div>
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    {readError && <p className="taskmd-error" role="alert">{readError} <button disabled={busy} onClick={() => setReload(value => value + 1)}>重试读取</button></p>}
    {displayed && <>
      <div className="taskmd-detail-summary">
        <span className={`taskmd-badge taskmd-status-${displayed.status}`}>{statusLabels[displayed.status]}</span>
        {state.ready.includes(displayed.id) && <span className="taskmd-badge taskmd-badge-ready">可开始</span>}
        {displayed.archived && <span className="taskmd-badge">已归档</span>}
        {!!count.total && <span className="taskmd-muted">子任务 {count.done}/{count.total} 完成{count.canceled > 0 && ` · ${count.canceled} 取消`}</span>}
        {finishable && <button disabled={busy} aria-label="明确完成此父任务" title="全部子任务已终态；确认完成父任务后解锁后续任务" onClick={() => { void finish(); }}>确认完成</button>}
      </div>
      {!!blockers.length && <section className="taskmd-box taskmd-blockers" aria-label="阻塞原因">
        <h4>等待中</h4><ul>{blockers.map((blocker, index) => <li key={index}>
          {blocker.dependencyId && <button onClick={() => onSelect(blocker.dependencyId!)}>{state.tasks.find(item => item.id === blocker.dependencyId)?.title || blocker.dependencyId}</button>}
          <span> {blocker.message}</span></li>)}</ul>
        <p className="taskmd-muted">以上为本任务或其祖先的直接依赖，只读说明，不可在此编辑继承依赖。</p>
      </section>}
      {record && <TaskProperties task={displayed} record={record} port={port} state={state} onChanged={onChanged} onSelect={onSelect} onDirty={setPropertiesDirty} bodyDirty={editorDirty} />}
      {sessions && <TaskSessionLauncher key={id} task={displayed} capability={sessions} />}
      {record && <TaskEditor record={record} port={port} state={state} onChanged={onChanged} onDirty={setEditorDirty} />}
      {record && <TaskAssets record={record} state={state} port={port} onChanged={onChanged} />}
      {sessions && <TaskSessions task={displayed} currentSessionId={sessionId} capability={sessions} port={port} />}
    </>}
  </div>;
}

/** Last opened first; missing `lastOpenedAt` falls back to `createdAt`, then session id for stability. */
function compareBindings(a: TaskSessionBinding, b: TaskSessionBinding): number {
  const at = a.lastOpenedAt ?? a.createdAt, bt = b.lastOpenedAt ?? b.createdAt;
  return at !== bt ? at < bt ? 1 : -1 : a.sessionId.localeCompare(b.sessionId);
}

function TaskSessions({ task, currentSessionId, capability, port }: {
  task: Task; currentSessionId?: string; capability: SessionCapability; port: TaskGraphPort;
}) {
  const taskId = task.id;
  const [bindings, setBindings] = useState<TaskSessionBinding[]>();
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => port.subscribe(() => setReload(value => value + 1)), [port]);
  useEffect(() => {
    const controller = new AbortController();
    void capability.list(taskId, controller.signal).then(value => {
      if (!controller.signal.aborted) { setBindings([...value].sort(compareBindings)); setListError(''); }
    }).catch(error => { if (!controller.signal.aborted) setListError(failure(error)); });
    return () => controller.abort();
  }, [capability, taskId, reload]);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); setReload(value => value + 1); }
    catch (error) { setError(failure(error)); }
    finally { setBusy(false); }
  };
  return <section className="taskmd-box"><h4>关联会话</h4>
    {error && <p role="alert" className="taskmd-error">{error}</p>}
    {listError && <p role="alert" className="taskmd-error">{listError} <button onClick={() => setReload(value => value + 1)}>重试</button></p>}
    <ul className="taskmd-sessions">{(bindings || []).map(binding => <li key={binding.sessionId}>
      <button disabled={busy} onClick={() => { void run(() => capability.open(binding.sessionId)); }}>{binding.sessionId}</button>
      <CopySessionId sessionId={binding.sessionId} />
      <button disabled={busy} onClick={() => { void run(() => capability.unbind(taskId, binding.sessionId)); }}>解除关联</button>
      <small>{binding.lastOpenedAt ? `最近打开 ${binding.lastOpenedAt}` : `创建于 ${binding.createdAt}`}</small>
    </li>)}</ul>
    {bindings !== undefined && bindings.length === 0 && <p className="taskmd-muted">此任务还没有关联会话。</p>}
    {bindings === undefined && !listError && <p className="taskmd-muted">正在读取关联会话…</p>}
    {currentSessionId && !(bindings || []).some(binding => binding.sessionId === currentSessionId) && <button disabled={busy} onClick={() => { void run(() => capability.bind(taskId, currentSessionId)); }}>关联当前会话</button>}
    <form onSubmit={event => { event.preventDefault(); if (sessionId.trim()) void run(() => capability.bind(taskId, sessionId.trim())); }}>
      <label>关联已有会话<input value={sessionId} onChange={event => setSessionId(event.target.value)} placeholder="会话 ID" /></label><button disabled={busy || !sessionId.trim()}>关联</button>
    </form>
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
  return <section className="taskmd-app taskmd-session-sidebar"><style>{styles}</style><h3>本会话任务</h3>
    {(error || actionError) && <p className="taskmd-error" role="alert">{error || actionError}</p>}
    {listError && <p className="taskmd-error" role="alert">{listError} <button onClick={() => setReload(value => value + 1)}>重试</button></p>}
    <ul className="taskmd-tree">{bindings.map(binding => {
      const task = state?.tasks.find(task => task.id === binding.taskId);
      return <li key={binding.taskId}><button onClick={() => onOpenTask(binding.taskId)}><strong>{task?.title || binding.taskId}</strong><small>{task ? statusLabels[task.status] : '任务不可用'}</small></button>
        <button disabled={busy} onClick={() => { void mutate(binding.taskId, true); }}>解除关联</button></li>;
    })}</ul>
    {bindings.length === 0 && <p className="taskmd-muted">当前会话尚未关联任务。</p>}
    {sessions && <form onSubmit={event => { event.preventDefault(); if (selected) void mutate(selected, false); }}>
      <label>关联任务<select value={selected} onChange={event => setSelected(event.target.value)}><option value="">选择任务</option>
        {state?.tasks.filter(task => !linked.has(task.id) && !task.archived).sort(compareTasks).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
      </select></label><button disabled={busy || !selected}>关联当前会话</button></form>}
  </section>;
}
