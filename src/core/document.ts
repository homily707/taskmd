import { createHash } from 'node:crypto';
import { isMap, parseDocument, stringify } from 'yaml';
import { TaskError, type Task, type TaskChanges } from '../types.js';

export const MAX_DOCUMENT = 1024 * 1024;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = new Set(['taskmd', 'id', 'title', 'summary', 'status', 'parent', 'order', 'archived']);
const changesFields = new Set(['title', 'summary', 'status', 'parent', 'order', 'archived', 'body']);

export function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
export function validateId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !UUID.test(id)) throw new TaskError('invalid_id', 'Task ID must be a lowercase UUID.');
}
function invalid(message: string): never { throw new TaskError('invalid_document', message); }
export function validateTask(task: Task): void {
  validateId(task.id);
  if (typeof task.title !== 'string' || !task.title.trim()) invalid('Title must be a nonempty string.');
  if (!['todo', 'in_progress', 'done', 'canceled'].includes(task.status)) invalid('Invalid task status.');
  if (task.parent !== null) validateId(task.parent);
  if (task.summary !== undefined && (typeof task.summary !== 'string' || task.summary.length > 500)) invalid('Summary must be a string of at most 500 characters.');
  if (!Number.isSafeInteger(task.order)) invalid('Order must be a safe integer.');
  if (typeof task.archived !== 'boolean') invalid('Archived must be a boolean.');
  if (typeof task.body !== 'string') invalid('Body must be a string.');
}
export function validateChanges(changes: TaskChanges): void {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) invalid('Changes must be an object.');
  for (const [key, value] of Object.entries(changes)) {
    if (!changesFields.has(key) || value === undefined) invalid(`Invalid task field: ${key}.`);
  }
}
function parts(content: string) {
  if (Buffer.byteLength(content) > MAX_DOCUMENT) throw new TaskError('file_too_large', 'Task documents must not exceed 1 MiB.');
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(content);
  if (!match || match.index !== 0) invalid('Task needs YAML frontmatter delimited by --- lines.');
  return { yaml: match[1]!, prefix: match[0], body: content.slice(match[0].length) };
}
/** A marker is an explicit format opt-in, not a claim of authorship. */
export function isManaged(content: string): boolean {
  return /^(?:\uFEFF)?---[ \t]*\r?\n/.test(content)
    && /^(?:taskmd|["']taskmd["'])\s*:/m.test(content.split(/^---[ \t]*\r?$/m)[1] ?? '');
}
function parse(content: string) {
  const split = parts(content);
  const document = parseDocument(split.yaml, { schema: 'core', uniqueKeys: true, resolveKnownTags: false });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) invalid('Invalid task YAML.');
  let data: Record<string, unknown>;
  try { data = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown>; }
  catch { invalid('YAML aliases are not supported.'); }
  if (data.taskmd !== 0.3 && data.taskmd !== '0.3') invalid('Unsupported taskmd format marker.');
  for (const key of Object.keys(data)) if (!fields.has(key)) invalid(`Unknown task field: ${key}.`);
  const task = { id: data.id, title: data.title, ...(data.summary !== undefined ? { summary: data.summary } : {}),
    status: data.status, parent: data.parent, order: data.order, archived: data.archived, body: split.body } as Task;
  validateTask(task);
  return { task, document, ...split };
}
export function parseTask(content: string): Task { return parse(content).task; }

export function createDocument(task: Task): string {
  validateTask(task);
  const { body, ...metadata } = task;
  const content = `---\n${stringify({ taskmd: 0.3, ...metadata }, { lineWidth: 0 })}---\n${body}`;
  parts(content);
  return content;
}
export function updateDocument(content: string, changes: TaskChanges): string {
  validateChanges(changes);
  const parsed = parse(content);
  validateTask({ ...parsed.task, ...changes });
  const body = changes.body ?? parsed.body;
  if (Object.keys(changes).every(key => key === 'body')) {
    const updated = parsed.prefix + (body && !parsed.prefix.endsWith('\n') ? '\n' : '') + body;
    parts(updated);
    return updated;
  }
  for (const [key, value] of Object.entries(changes)) if (key !== 'body') parsed.document.set(key, value);
  const updated = `---\n${parsed.document.toString({ lineWidth: 0 })}---\n${body}`;
  parseTask(updated);
  return updated;
}
