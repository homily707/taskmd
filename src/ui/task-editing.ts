import type { TaskRecord } from '../types.js';

export interface BodyDraft { body: string; baseBody: string; version: string }
const memory = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
export function subscribeLocal(key: string, listener: () => void): () => void {
  const bucket = listeners.get(key) ?? new Set<() => void>();
  bucket.add(listener); listeners.set(key, bucket);
  return () => { bucket.delete(listener); if (!bucket.size) listeners.delete(key); };
}
/** Test isolation only; production drafts are scoped by task ID. */
export function clearLocal(): void {
  memory.clear(); listeners.clear();
  try { globalThis.sessionStorage?.clear(); } catch { /* Ignore unavailable storage. */ }
}
export const draftKey = (record: TaskRecord) => `taskmd:0.3:draft:${record.task.id}`;
export function loadLocal<T>(key: string): T | undefined {
  if (memory.has(key)) return memory.get(key) as T;
  try { const raw = globalThis.sessionStorage?.getItem(key); return raw ? JSON.parse(raw) as T : undefined; } catch { return; }
}
/** Memory keeps navigation safe even if browser storage is unavailable. */
export function storeLocal(key: string, value: unknown): boolean {
  memory.set(key, value);
  // Notify after storage has changed so other mounted editors read the same draft.
  const notify = () => { for (const listener of listeners.get(key) ?? []) listener(); };
  try {
    if (typeof sessionStorage === 'undefined') return false;
    if (value === undefined) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; } finally { notify(); }
}
export function readDraft(record: TaskRecord): BodyDraft | undefined {
  const value = loadLocal<BodyDraft>(draftKey(record));
  return value && typeof value.body === 'string' && typeof value.baseBody === 'string' && typeof value.version === 'string' ? value : undefined;
}
export const isVersionConflict = (cause: unknown) => !!cause && typeof cause === 'object' && 'code' in cause && cause.code === 'version_conflict';
