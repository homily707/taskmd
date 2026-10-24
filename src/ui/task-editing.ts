import type { Plan, State, TaskChanges, TaskRecord } from '../types.js';
import type { TaskGraphPort } from './port.js';

/**
 * Patches one task against the version the editor started from.
 *
 * A body-only patch is deliberate: the Store's `updateDocument` rewrites just
 * the body when every changed key is `body`, so frontmatter comments and
 * unknown fields survive untouched. `replaceMarkdown` would require the client
 * to rebuild the whole document and would drop anything it does not model.
 */
export function taskPatch(target: { id: string; version: string }, revision: string, changes: TaskChanges): Plan {
  return { requestId: crypto.randomUUID(), baseRevision: revision,
    operations: [{ op: 'patch', id: target.id, expectedVersion: target.version, changes }] };
}

/** Renders a TaskError (code, message, hint, validation diagnostics) for humans. */
export function taskFailure(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const value = error as { code?: string; message?: string; hint?: string; details?: unknown };
  const details = value.details;
  const diagnostics = Array.isArray(details) ? details
    : details && typeof details === 'object' && 'diagnostics' in details ? (details as { diagnostics: unknown }).diagnostics : [];
  const messages = Array.isArray(diagnostics)
    ? diagnostics.map(item => item && typeof item === 'object' && typeof (item as { message?: unknown }).message === 'string'
      ? (item as { message: string }).message : '').filter(Boolean)
    : [];
  const head = [value.code, value.message || String(error)].filter(Boolean).join(': ');
  return [head, value.hint, ...messages.map(message => `- ${message}`),
    messages.length ? '' : details === undefined ? '' : JSON.stringify(details, null, 2)].filter(Boolean).join('\n');
}

export function isVersionConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && String((error as { code?: unknown }).code).toLowerCase() === 'version_conflict';
}

const MAX_DIFF_LINES = 200;

/** A contiguous line diff: retain common edges and show every changed line. */
export function bodyDiff(latest: string, draft: string): string {
  if (latest === draft) return '正文相同；其他字段或任务库版本发生变化。';
  const before = latest.split('\n'), after = draft.split('\n');
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (end < before.length - start && end < after.length - start
    && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  const hidden = (removed.length - MAX_DIFF_LINES) + (added.length - MAX_DIFF_LINES);
  return ['--- 最新正文', '+++ 本地草稿', `@@ 第 ${start + 1} 行起 @@`,
    ...removed.slice(0, MAX_DIFF_LINES).map(line => `- ${line}`),
    ...added.slice(0, MAX_DIFF_LINES).map(line => `+ ${line}`),
    ...(hidden > 0 ? [`… 另有 ${hidden} 行差异未显示，可复制草稿后比较`] : [])].join('\n');
}

/** Re-reads the task and the store revision; callers re-check `active` after awaiting. */
export async function latestTask(port: Pick<TaskGraphPort, 'getState' | 'readTask'>, id: string) {
  const state: State = await port.getState();
  const record: TaskRecord = await port.readTask(id);
  return { record, revision: state.revision };
}

/** Reads a JSON draft; missing storage and malformed values are the same "no draft". */
export function loadDraft(key: string): unknown {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    return value === null ? undefined : value;
  } catch { return undefined; }
}

/** Writes or clears a draft. `false` means the browser refused storage. */
export function storeDraft(key: string, value: unknown | undefined): boolean {
  try {
    if (value === undefined) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

/** Destructive draft actions ask first; hosts without a dialog must not be blocked. */
export function confirmDiscard(message: string): boolean {
  return typeof window === 'undefined' || typeof window.confirm !== 'function' || window.confirm(message);
}

/** Clipboard access is optional (non-secure contexts, tests); callers report failure. */
export async function copyText(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) throw new Error('当前环境不提供剪贴板');
  await clipboard.writeText(text);
}
