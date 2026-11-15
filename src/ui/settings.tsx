import { useId, useState } from 'react';
import type { HomeSettings } from '../types.js';
import type { SessionCapability, TaskPort } from './port.js';
import { failure, useWorkspaces } from './shared.js';

export function HomeConfiguration({ settings, port, sessions, onChanged }: { settings: HomeSettings; port: TaskPort; sessions?: SessionCapability; onChanged(): Promise<void> }) {
  const [workspaceId, setWorkspaceId] = useState(settings.homeWorkspaceId ?? '');
  const [directory, setDirectory] = useState(settings.tasksDirectory);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const workspaces = useWorkspaces(sessions);
  const id = useId();
  return <details open={!settings.homeDirectory} className="taskmd-settings"><summary>Home 设置</summary>
    <p className="taskmd-muted">任务统一保存在固定的 Home；切换 Session 不会切换 Home。</p>
    <form onSubmit={event => {
      event.preventDefault(); if (busy) return;
      const workspace = workspaces.items.find(item => item.workspaceId === workspaceId);
      if (!workspace) { setError('请选择 DSH 工作区作为 Home。'); return; }
      setBusy(true); setError('');
      void port.configure({ homeDirectory: workspace.path, homeWorkspaceId: workspace.workspaceId, tasksDirectory: directory.trim() || 'tasks' }).then(onChanged).catch(cause => setError(failure(cause))).finally(() => setBusy(false));
    }}>
      <label htmlFor={`${id}-home`}>Home 工作区</label><select id={`${id}-home`} required value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>
        <option value="">选择 DSH 工作区</option>{workspaces.items.map(item => <option key={item.workspaceId} value={item.workspaceId}>{item.title} · {item.path}</option>)}
      </select>
      <label htmlFor={`${id}-directory`}>Home 内的任务目录</label><input id={`${id}-directory`} value={directory} required onChange={event => setDirectory(event.target.value)} />
      <button disabled={busy || !workspaceId}>保存 Home 设置</button>
    </form>
    {(error || workspaces.error) && <p role="alert" className="taskmd-error">{error || workspaces.error}</p>}
    {workspaces.error && <button onClick={workspaces.refresh}>重试读取工作区</button>}
  </details>;
}
