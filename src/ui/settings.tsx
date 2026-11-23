import { useId, useState } from 'react';
import type { HomeSettings, TemplatePaths } from '../types.js';
import type { SessionCapability, TaskPort } from './port.js';
import { failure, useWorkspaces } from './shared.js';

export function HomeConfiguration({ settings, port, sessions, onChanged }: { settings: HomeSettings; port: TaskPort; sessions?: SessionCapability; onChanged(): Promise<void> }) {
  const [workspaceId, setWorkspaceId] = useState(settings.homeWorkspaceId ?? '');
  const [directory, setDirectory] = useState(settings.tasksDirectory);
  const [initialPath, setInitialPath] = useState(settings.templatePaths?.initial ?? '');
  const [reviewPath, setReviewPath] = useState(settings.templatePaths?.review ?? '');
  const [taskPath, setTaskPath] = useState(settings.templatePaths?.task ?? '');
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
      const values = { initial: initialPath.trim(), review: reviewPath.trim(), task: taskPath.trim() };
      const templatePaths = Object.fromEntries(Object.entries(values).filter(([, path]) => path)) as TemplatePaths;
      setBusy(true); setError('');
      void port.configure({ homeDirectory: workspace.path, homeWorkspaceId: workspace.workspaceId, tasksDirectory: directory.trim() || 'tasks',
        ...(Object.keys(templatePaths).length ? { templatePaths } : {}),
      }).then(onChanged).catch(cause => setError(failure(cause))).finally(() => setBusy(false));
    }}>
      <label htmlFor={`${id}-home`}>Home 工作区</label><select id={`${id}-home`} required value={workspaceId} onChange={event => setWorkspaceId(event.target.value)}>
        <option value="">选择 DSH 工作区</option>{workspaces.items.map(item => <option key={item.workspaceId} value={item.workspaceId}>{item.title} · {item.path}</option>)}
      </select>
      <label htmlFor={`${id}-directory`}>Home 内的任务目录</label><input id={`${id}-directory`} value={directory} required onChange={event => setDirectory(event.target.value)} />
      <p className="taskmd-muted">模板是本地 Markdown 文件，保存后再次使用会读取最新内容。路径留空时使用 DSH profile/data/taskmd/templates/ 中自动创建的默认文件。支持绝对路径或 ~/ 开头的路径。</p>
      <label htmlFor={`${id}-initial-template`}>初始 Prompt 模板路径</label>
      <input id={`${id}-initial-template`} value={initialPath} placeholder="留空使用 initial.md" onChange={event => setInitialPath(event.target.value)} />
      <label htmlFor={`${id}-review-template`}>Review Prompt 模板路径</label>
      <input id={`${id}-review-template`} value={reviewPath} placeholder="留空使用 review.md" onChange={event => setReviewPath(event.target.value)} />
      <label htmlFor={`${id}-task-template`}>新任务正文模板路径</label>
      <input id={`${id}-task-template`} value={taskPath} placeholder="留空使用 task.md" onChange={event => setTaskPath(event.target.value)} />
      <button disabled={busy || !workspaceId}>保存 Home 设置</button>
    </form>
    <p className="taskmd-muted">将 JSON 会话请求放入 <code>{directory.trim() || 'tasks'}/inbox/</code>，会自动创建一个 Session（可指定仓库、Agent preset、模型、初始 Prompt 和可选任务绑定）。</p>
    {(error || workspaces.error) && <p role="alert" className="taskmd-error">{error || workspaces.error}</p>}
    {workspaces.error && <button onClick={workspaces.refresh}>重试读取工作区</button>}
  </details>;
}
