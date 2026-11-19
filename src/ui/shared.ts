import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { State, Task, TaskSessionBinding } from '../types.js';
import { agentView, type TaskAgentView } from './agent-status.js';
import type { SessionCapability, SessionStatus, TaskPort, WorkspaceSummary } from './port.js';

export const statusLabels = { todo: '待办', in_progress: '进行中', done: '已完成', canceled: '已取消' } as const;
export const compareTasks = (a: Task, b: Task) => a.order - b.order || a.id.localeCompare(b.id);
export const failure = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
/**
 * Transport-level failures that resolve themselves (e.g. the Host half is briefly
 * unmounted during a plugin reload, so `/api/taskmd/state` answers 404). These are
 * not user-actionable and must never be surfaced as a persistent panel error.
 */
export const isTransientTransportError = (message: string) =>
  /transport failure/i.test(message) || /taskmd\/state failed/i.test(message) || /HTTP 404/i.test(message);
export function descendants(tasks: Task[], id: string): Set<string> {
  const result = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const task of tasks) if (task.parent && result.has(task.parent) && !result.has(task.id)) { result.add(task.id); changed = true; }
  }
  return result;
}
export function useTasks(port: TaskPort) {
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const request = useRef<AbortController>();
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try {
      const next = await port.getState(controller.signal);
      if (!controller.signal.aborted) { setState(next); setError(''); }
    } catch (cause) { if (!controller.signal.aborted) { const message = failure(cause); if (!isTransientTransportError(message)) setError(message); } }
  }, [port]);
  useEffect(() => {
    setState(undefined); void refresh();
    const stop = port.subscribe(() => { void refresh(); });
    const focus = () => { void refresh(); };
    if (typeof window !== 'undefined') window.addEventListener('focus', focus);
    return () => { stop(); request.current?.abort(); if (typeof window !== 'undefined') window.removeEventListener('focus', focus); };
  }, [port, refresh]);
  return { state, error, refresh };
}
export function useSessions(sessions: SessionCapability | undefined, port: TaskPort) {
  const [bindings, setBindings] = useState<TaskSessionBinding[]>([]);
  const [statuses, setStatuses] = useState<Map<string, SessionStatus>>(new Map());
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(value => value + 1), []);
  useEffect(() => port.subscribe(refresh), [port, refresh]);
  useEffect(() => {
    const source = sessions?.statuses?.();
    if (!source) { setStatuses(new Map()); return; }
    const update = () => setStatuses(new Map(source.get()));
    update(); return source.subscribe(update);
  }, [sessions]);
  useEffect(() => {
    const controller = new AbortController();
    if (!sessions) { setBindings([]); return; }
    void sessions.list(undefined, controller.signal).then(value => {
      if (!controller.signal.aborted) { setBindings(value); setError(''); }
    }, cause => { if (!controller.signal.aborted) setError(failure(cause)); });
    return () => controller.abort();
  }, [sessions, tick]);
  // Archived Sessions stay in the binding store (so EasyRewrite's version
  // switching can bring them back), but they are not part of the task view.
  const visible = useMemo(
    () => bindings.filter(binding => !statuses.get(binding.sessionId)?.archived),
    [bindings, statuses],
  );
  return { bindings: visible, statuses, error, refresh };
}
export function useWorkspaces(sessions?: SessionCapability) {
  const [items, setItems] = useState<WorkspaceSummary[]>([]);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(value => value + 1), []);
  useEffect(() => sessions?.subscribeTargets?.(refresh), [sessions, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    if (!sessions) return;
    void sessions.workspaces(controller.signal).then(value => {
      if (!controller.signal.aborted) { setItems(value); setError(''); }
    }, cause => { if (!controller.signal.aborted) setError(failure(cause)); });
    return () => controller.abort();
  }, [sessions, tick]);
  return { items, error, refresh };
}
export function sessionLabel(sessions: SessionCapability, id: string, status?: SessionStatus) {
  return sessions.title?.(id) || status?.title || id;
}
export function agentLabel(status?: SessionStatus) {
  return status?.missing ? '会话不存在' : status?.pending ? '等待回应' : status?.running ? '运行中' : status?.fresh ? '有新消息' : '空闲';
}

/** Last opened first; missing `lastOpenedAt` falls back to `createdAt`, then session id for stability. */
export function compareBindings(a: TaskSessionBinding, b: TaskSessionBinding): number {
  const at = a.lastOpenedAt ?? a.createdAt, bt = b.lastOpenedAt ?? b.createdAt;
  return at !== bt ? at < bt ? 1 : -1 : a.sessionId.localeCompare(b.sessionId);
}

/** Every binding merged with live session status, shared by the sidebar and main outline. */
export function useAgentView(sessions: SessionCapability | undefined, port: TaskPort) {
  const { bindings, statuses, error } = useSessions(sessions, port);
  const bindingsByTask = useMemo(() => {
    const map = new Map<string, TaskSessionBinding[]>();
    for (const binding of bindings) {
      const list = map.get(binding.taskId) ?? [];
      list.push(binding);
      map.set(binding.taskId, list);
    }
    for (const list of map.values()) list.sort(compareBindings);
    return map;
  }, [bindings]);
  const views = useMemo(() => {
    const map = new Map<string, TaskAgentView>();
    for (const [taskId, list] of bindingsByTask) {
      const statusesForTask = list.map(binding => statuses.get(binding.sessionId)).filter((status): status is SessionStatus => !!status);
      if (statusesForTask.length) map.set(taskId, agentView(statusesForTask));
    }
    return map;
  }, [bindingsByTask, statuses]);
  const totals = useMemo(() => {
    let attention = 0, running = 0, fresh = 0;
    for (const view of views.values()) { attention += view.attention; running += view.running; fresh += view.fresh; }
    return { attention, running, fresh };
  }, [views]);
  return { bindings, bindingsByTask, statuses, views, totals, error, enabled: !!sessions?.statuses };
}

/** Rolls every descendant's sessions into one view for parent rows and chips. */
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
