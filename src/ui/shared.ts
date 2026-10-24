import { useCallback, useEffect, useRef, useState } from 'react';
import type { State, Task } from '../types.js';
import type { TaskGraphPort } from './port.js';

export const statusLabels = { todo: '待办', in_progress: '进行中', done: '完成', canceled: '取消' } as const;
export const compareTasks = (a: Task, b: Task) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.id.localeCompare(b.id);
export function failure(error: unknown): string {
  const e = error as { message?: string; details?: unknown };
  const details = e?.details;
  const diagnostics = Array.isArray(details) ? details : details && typeof details === 'object' && 'diagnostics' in details ? (details as { diagnostics: unknown }).diagnostics : [];
  const messages = Array.isArray(diagnostics) ? diagnostics.map(d => typeof d?.message === 'string' ? d.message : '').filter(Boolean) : [];
  return [e?.message || String(error), ...messages].join('\n');
}
export function useTasks(port: TaskGraphPort) {
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const request = useRef<AbortController>();
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try {
      const next = await port.getState(controller.signal);
      if (!controller.signal.aborted) { setState(next); setError(''); }
    } catch (error) { if (!controller.signal.aborted) setError(failure(error)); }
  }, [port]);
  useEffect(() => {
    setState(undefined); void refresh();
    const stop = port.subscribe(() => { void refresh(); });
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { stop(); request.current?.abort(); window.removeEventListener('focus', focus); };
  }, [port, refresh]);
  return { state, error, refresh };
}
export function descendants(tasks: Task[], id: string): Set<string> {
  const result = new Set([id]);
  const children = new Map<string, string[]>();
  for (const task of tasks) if (task.parent) children.set(task.parent, [...children.get(task.parent) || [], task.id]);
  const queue = [id];
  for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]!) || []) {
    if (!result.has(child)) { result.add(child); queue.push(child); }
  }
  return result;
}
export function progress(tasks: Task[], id: string) {
  const children = tasks.filter(task => task.parent === id);
  const done = children.filter(task => task.status === 'done').length;
  const canceled = children.filter(task => task.status === 'canceled').length;
  return { total: children.length, done, canceled, terminal: done + canceled };
}
