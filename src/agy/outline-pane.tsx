import { useMemo, useState } from 'react';
import type { SessionCapability, TaskPort } from '../ui/port.js';
import { TaskOutline } from '../ui/task-outline.js';
import { HomeConfiguration } from '../ui/settings.js';
import { failure, useAgentView, useTasks } from '../ui/shared.js';
import { styles } from '../ui/styles.js';

export interface AgyOutlinePaneProps {
  port: TaskPort;
  sessions: SessionCapability;
  sessionId?: string;
}

export function pickPreferredSessionId(
  taskId: string,
  bindingsByTask: Map<string, { sessionId: string }[]>,
  statuses: Map<string, { archived?: boolean; updatedAt?: number }>,
): string | undefined {
  const bindings = bindingsByTask.get(taskId) ?? [];
  if (!bindings.length) return undefined;
  const live = bindings.filter(item => !statuses.get(item.sessionId)?.archived);
  const candidates = live.length ? live : bindings;
  return [...candidates].sort((a, b) => {
    const timeA = statuses.get(a.sessionId)?.updatedAt ?? 0;
    const timeB = statuses.get(b.sessionId)?.updatedAt ?? 0;
    return timeB - timeA;
  })[0]?.sessionId;
}

export function AgyOutlinePane({ port, sessions, sessionId }: AgyOutlinePaneProps) {
  const { state, error, refresh } = useTasks(port);
  const agent = useAgentView(sessions, port);
  const [selected, setSelected] = useState<string>();
  const [hint, setHint] = useState('');

  const activeTaskId = useMemo(() => {
    if (!sessionId) return undefined;
    for (const [taskId, list] of agent.bindingsByTask) {
      if (list.some(item => item.sessionId === sessionId)) return taskId;
    }
    return undefined;
  }, [agent.bindingsByTask, sessionId]);

  const highlighted = selected ?? activeTaskId;

  const handleSelect = (taskId: string) => {
    setSelected(taskId);
    setHint('');
    const targetSessionId = pickPreferredSessionId(taskId, agent.bindingsByTask, agent.statuses);
    if (!targetSessionId) {
      setHint('该任务尚未关联会话，可在输入框旁选择任务后发送消息自动绑定。');
      return;
    }
    void sessions.open(targetSessionId).catch(cause => setHint(failure(cause)));
  };

  return (
    <div className="taskmd-app taskmd-full">
      <style>{styles}</style>
      <header className="taskmd-header">
        <div className="taskmd-heading">
          <h2>任务</h2>
          <span className="taskmd-count">{state?.tasks.length ?? '…'}</span>
        </div>
        <div
          className="taskmd-agent-summary"
          role="group"
          aria-label={`Agent 状态：${agent.totals.attention} 个等你处理，${agent.totals.running} 个运行中，${agent.totals.fresh} 个有新结果`}
        >
          <span className="taskmd-agent-summary-label">Agent</span>
          {agent.totals.attention > 0 && (
            <span className="taskmd-agent-pill is-attention" title="等待你处理的 Session">
              <span aria-hidden="true">⚠</span> {agent.totals.attention}
            </span>
          )}
          {agent.totals.running > 0 && (
            <span className="taskmd-agent-pill is-running" title="运行中的 Session">
              <span aria-hidden="true">●</span> {agent.totals.running}
            </span>
          )}
          {agent.totals.fresh > 0 && (
            <span className="taskmd-agent-pill is-fresh" title="有新结果的 Session">
              <span aria-hidden="true">✓</span> {agent.totals.fresh}
            </span>
          )}
          {agent.totals.attention + agent.totals.running + agent.totals.fresh === 0 && (
            <span className="taskmd-agent-idle">空闲</span>
          )}
        </div>
      </header>
      {error && (
        <p role="alert" className="taskmd-error">
          {error} <button onClick={() => void refresh()}>重试</button>
        </p>
      )}
      {hint && <p className="taskmd-muted" role="status">{hint}</p>}
      {!state ? (
        error ? (
          <HomeConfiguration
            settings={{ homeDirectory: '', homeWorkspaceId: null, tasksDirectory: 'tasks' }}
            port={port}
            sessions={sessions}
            onChanged={refresh}
          />
        ) : (
          <p>正在读取任务…</p>
        )
      ) : (
        <div className="taskmd-outline-only">
          <TaskOutline
            state={state}
            port={port}
            selected={highlighted}
            onSelect={handleSelect}
            onChanged={refresh}
            agent={agent}
          />
          <HomeConfiguration
            key={`${state.settings.homeDirectory}:${state.settings.tasksDirectory}`}
            settings={state.settings}
            port={port}
            sessions={sessions}
            onChanged={refresh}
          />
          {!!state.diagnostics.length && (
            <details>
              <summary>文件提示 · {state.diagnostics.length}</summary>
              <ul>
                {state.diagnostics.map((item, index) => (
                  <li key={index}>{item.path}：{item.message}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
