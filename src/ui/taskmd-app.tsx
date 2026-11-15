import { useEffect, useId, useRef, useState } from 'react';
import type { State, TaskRecord, TaskStatus } from '../types.js';
import type { SessionCapability, TaskPort } from './port.js';
import { TaskOutline } from './task-outline.js';
import { TaskEditor, useBodyDraft } from './task-editor.js';
import { TaskProperties } from './task-properties.js';
import { TaskSessionLauncher } from './session-launcher.js';
import { HomeConfiguration } from './settings.js';
import { agentLabel, descendants, failure, sessionLabel, statusLabels, useAgentView, useSessions, useTasks } from './shared.js';
import { levelOf } from './agent-status.js';

const bindingStatus = (status?: Parameters<typeof levelOf>[0]) => status ? levelOf(status) : 'idle';
import { styles } from './styles.js';

export interface TaskmdAppProps { port: TaskPort; sessions?: SessionCapability; initialTaskId?: string; selectionToken?: number; sessionId?: string }
export function TaskmdApp({ port, sessions, initialTaskId, selectionToken, sessionId }: TaskmdAppProps) {
  const { state, error, refresh } = useTasks(port);
  const [selected, setSelected] = useState(initialTaskId);
  const [detail, setDetail] = useState(!!initialTaskId);
  useEffect(() => { if (initialTaskId) { setSelected(initialTaskId); setDetail(true); } }, [initialTaskId, selectionToken]);
  const record = state?.tasks.find(item => item.task.id === selected);
  const agent = useAgentView(sessions, port);
  return <div className="taskmd-app taskmd-full"><style>{styles}</style>
    <header className="taskmd-header">
      <div className="taskmd-heading"><h2>任务</h2><span className="taskmd-count">{state?.tasks.length ?? '…'}</span></div>
      <div className="taskmd-agent-summary" role="group" aria-label={`Agent 状态：${agent.totals.attention} 个等你处理，${agent.totals.running} 个运行中，${agent.totals.fresh} 个有新结果`}>
        <span className="taskmd-agent-summary-label">Agent</span>
        {agent.totals.attention > 0 && <span className="taskmd-agent-pill is-attention" title="等待你处理的 Session"><span aria-hidden="true">⚠</span> {agent.totals.attention}</span>}
        {agent.totals.running > 0 && <span className="taskmd-agent-pill is-running" title="运行中的 Session"><span aria-hidden="true">●</span> {agent.totals.running}</span>}
        {agent.totals.fresh > 0 && <span className="taskmd-agent-pill is-fresh" title="有新结果的 Session"><span aria-hidden="true">✓</span> {agent.totals.fresh}</span>}
        {agent.totals.attention + agent.totals.running + agent.totals.fresh === 0 && <span className="taskmd-agent-idle">空闲</span>}
      </div>
      <span className="taskmd-home" title={state?.settings.homeDirectory}>Home · {state?.settings.homeDirectory || '尚未配置'}</span>
    </header>
    {error && <p role="alert" className="taskmd-error">{error} <button onClick={() => void refresh()}>重试</button></p>}
    {!state ? error ? <HomeConfiguration settings={{ homeDirectory: '', homeWorkspaceId: null, tasksDirectory: 'tasks' }} port={port} sessions={sessions} onChanged={refresh} /> : <p>正在读取任务…</p> : <>
      <div className={`taskmd-columns ${detail ? 'taskmd-show-detail' : ''}`}>
        <aside className="taskmd-list-pane"><TaskOutline state={state} port={port} selected={selected} onSelect={id => { setSelected(id); setDetail(true); }} onChanged={refresh} agent={agent} />
          <HomeConfiguration key={`${state.settings.homeDirectory}:${state.settings.tasksDirectory}`} settings={state.settings} port={port} sessions={sessions} onChanged={refresh} />
          {!!state.diagnostics.length && <details><summary>文件提示 · {state.diagnostics.length}</summary><ul>{state.diagnostics.map((item, index) => <li key={index}>{item.path}：{item.message}</li>)}</ul></details>}
        </aside>
        <div className="taskmd-detail-pane"><button className="taskmd-back" onClick={() => setDetail(false)}>返回任务大纲</button>
          {record ? <TaskDetail key={record.task.id} record={record} state={state} port={port} sessions={sessions} sessionId={sessionId} onChanged={refresh} /> : <p className="taskmd-empty">选择任务，阅读 Markdown 正文。</p>}
        </div>
      </div>
    </>}
  </div>;
}

function TaskSessions({ record, port, sessions, sessionId }: { record: TaskRecord; port: TaskPort; sessions: SessionCapability; sessionId?: string }) {
  const agent = useSessions(sessions, port);
  const [existing, setExisting] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const bindings = agent.bindings.filter(item => item.taskId === record.task.id);
  const action = async (run: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError('');
    try { await run(); agent.refresh(); } catch (cause) { setError(failure(cause)); } finally { setBusy(false); }
  };
  return <section className="taskmd-sessions" aria-label="关联的 Session"><h3>Session <small>{bindings.length}</small></h3>
    {bindings.length ? <ul>{bindings.map(binding => <li key={binding.sessionId}><button onClick={() => void action(() => sessions.open(binding.sessionId))}>{sessionLabel(sessions, binding.sessionId, agent.statuses.get(binding.sessionId))}</button><small className={`taskmd-status-text is-${bindingStatus(agent.statuses.get(binding.sessionId))}`}> · Agent {agentLabel(agent.statuses.get(binding.sessionId))}</small><details><summary>关联操作</summary><button disabled={busy} onClick={() => void action(() => sessions.unbind(record.task.id, binding.sessionId))}>解除关联</button></details></li>)}</ul> : <p className="taskmd-muted">尚未关联 Session。</p>}
    <details><summary>关联已有 Session</summary>
      <form onSubmit={event => { event.preventDefault(); if (existing.trim()) void action(() => sessions.bind(record.task.id, existing.trim())); }}>
        <label htmlFor={`${ids}-existing`}>Session ID</label><input id={`${ids}-existing`} required value={existing} onChange={event => setExisting(event.target.value)} />
        {!!agent.statuses.size && <><label htmlFor={`${ids}-known`}>选择会话</label><select id={`${ids}-known`} value={existing} onChange={event => setExisting(event.target.value)}><option value="">选择已有 Session</option>{[...agent.statuses.values()].filter(item => !item.missing).map(item => <option key={item.sessionId} value={item.sessionId}>{sessionLabel(sessions, item.sessionId, item)}</option>)}</select></>}
        {agent.bindings.some(item => item.sessionId === existing.trim() && item.taskId !== record.task.id) && <p>此 Session 已关联其他任务，继续会改绑到当前任务。</p>}
        <button disabled={busy || !existing.trim()}>关联 Session</button>
        {sessionId && !bindings.some(item => item.sessionId === sessionId) && <button type="button" disabled={busy} onClick={() => void action(() => sessions.bind(record.task.id, sessionId))}>关联当前 Session</button>}
      </form>
    </details>
    {(error || agent.error) && <p role="alert" className="taskmd-error">{error || agent.error}</p>}
  </section>;
}

function TaskDetail({ record, state, port, sessions, sessionId, onChanged }: { record: TaskRecord; state: State; port: TaskPort; sessions?: SessionCapability; sessionId?: string; onChanged(): Promise<void> }) {
  const editor = useBodyDraft(record, port, onChanged);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { setConfirming(false); }, [record.task.id]);
  const subtree = descendants(state.tasks.map(item => item.task), record.task.id).size;
  const run = (action: () => Promise<unknown>) => {
    if (busy) return; setBusy(true); setError('');
    void action().then(onChanged).catch(cause => setError(failure(cause))).finally(() => setBusy(false));
  };
  return <article className="taskmd-detail">
    <header className="taskmd-detail-head"><h2 className="taskmd-detail-title" ref={heading} tabIndex={-1}>{record.task.title}</h2><div className="taskmd-detail-actions">
      <label htmlFor={`${id}-actions`}>任务操作</label>
      <select id={`${id}-actions`} aria-label="任务操作" value="" disabled={busy} onChange={event => {
        const value = event.target.value;
        if (value === 'archive') run(() => port.updateTask(record.task.id, { archived: !record.task.archived }, record.version));
        else if (value === 'delete') setConfirming(true);
        else if (value) run(() => port.updateTask(record.task.id, { status: value as TaskStatus }, record.version));
        event.target.value = '';
      }}>
        <option value="">{record.task.archived ? `已归档 · ${statusLabels[record.task.status]}` : statusLabels[record.task.status]}</option>
        {Object.entries(statusLabels).filter(([value]) => value !== record.task.status).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        <option value="archive">{record.task.archived ? '恢复任务' : '归档'}</option>
        <option value="delete" className="taskmd-danger-option">删除{subtree > 1 ? `（含 ${subtree - 1} 个子任务）` : ''}</option>
      </select>
      {confirming
        ? <>
          <button className="taskmd-danger" disabled={busy} onClick={() => run(() => port.deleteTask(record.task.id, record.version))}>确认删除</button>
          <button disabled={busy} onClick={() => setConfirming(false)}>取消</button>
        </>
        : null}
    </div></header>
    {error && <p role="alert" className="taskmd-error">{error}</p>}
    <TaskEditor record={record} port={port} editor={editor} />
    {sessions && <><TaskSessions record={record} port={port} sessions={sessions} sessionId={sessionId} />
      <TaskSessionLauncher record={record} settings={state.settings} capability={sessions} save={editor.save} onChanged={() => void onChanged()} /></>}
    <TaskProperties record={record} state={state} port={port} onChanged={onChanged} />
    <details><summary>Markdown 文件</summary><p className="taskmd-path">{record.path}</p><p className="taskmd-muted">任务 ID：{record.task.id}</p></details>
  </article>;
}

export function TaskmdDetailPanel({ port, sessions, taskId, sessionId }: { port: TaskPort; sessions?: SessionCapability; taskId: string; sessionId?: string }) {
  const { state, error, refresh } = useTasks(port);
  const record = state?.tasks.find(item => item.task.id === taskId);
  return <div className="taskmd-app"><style>{styles}</style>{error && <p role="alert">{error}</p>}{record && state ? <TaskDetail key={record.task.id} record={record} state={state} port={port} sessions={sessions} sessionId={sessionId} onChanged={refresh} /> : <p>{state ? '任务不存在或 Home 已切换。' : '正在读取任务…'}</p>}</div>;
}

export function TaskmdSidebar({ port, sessions, sessionId, onOpenTask }: { port: TaskPort; sessions: SessionCapability; sessionId: string; onOpenTask(id: string): void }) {
  const { state, error, refresh } = useTasks(port);
  const agent = useSessions(sessions, port);
  const [selected, setSelected] = useState('');
  const [actionError, setActionError] = useState('');
  const bound = agent.bindings.filter(binding => binding.sessionId === sessionId);
  const ids = new Set(bound.map(binding => binding.taskId));
  const records = state?.tasks.filter(record => ids.has(record.task.id)) ?? [];
  return <div className="taskmd-app taskmd-session-sidebar"><style>{styles}</style><h2>当前 Session 的任务</h2>
    {(error || agent.error || actionError) && <p role="alert">{error || agent.error || actionError}</p>}
    {records.map(record => <details key={record.task.id} open><summary>{record.task.title}</summary><button onClick={() => onOpenTask(record.task.id)}>打开任务正文</button><TaskDetail record={record} state={state!} port={port} sessions={sessions} sessionId={sessionId} onChanged={refresh} /></details>)}
    {!records.length && <p className="taskmd-muted">此 Session 尚未关联任务。</p>}
    <details><summary>关联任务到当前 Session</summary><label>任务<select aria-label="关联任务" value={selected} onChange={event => setSelected(event.target.value)}><option value="">选择任务</option>{state?.tasks.filter(record => !ids.has(record.task.id)).map(record => <option key={record.task.id} value={record.task.id}>{record.task.title}</option>)}</select></label><button disabled={!selected} onClick={() => void sessions.bind(selected, sessionId).then(agent.refresh).catch(cause => setActionError(failure(cause)))}>{bound.length ? '改绑当前 Session' : '关联到当前 Session'}</button></details>
  </div>;
}
