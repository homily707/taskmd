import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { hash, UUID } from './document.js';
import { TaskError, type Diagnostic, type SessionInboxEntry, type SessionInboxModel, type SessionInboxRequest } from '../types.js';

/** Requests larger than this are almost certainly not a session descriptor. */
export const MAX_REQUEST = 256 * 1024;
const FIELDS = new Set(['version', 'workspaceId', 'cwd', 'agentPreset', 'model', 'taskId', 'title', 'prompt']);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function invalid(message: string): never { throw new TaskError('invalid_request', message); }

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`"${name}" must be a nonempty string.`);
  return value;
}
function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmpty(value, name);
}
function parseModel(value: unknown): SessionInboxModel {
  if (!object(value)) invalid('"model" must be an object.');
  for (const key of Object.keys(value)) if (!['provider', 'model', 'reasoningEffort'].includes(key)) invalid(`Unknown model field: ${key}.`);
  return {
    provider: nonEmpty(value.provider, 'model.provider'),
    model: nonEmpty(value.model, 'model.model'),
    ...(value.reasoningEffort !== undefined ? { reasoningEffort: nonEmpty(value.reasoningEffort, 'model.reasoningEffort') } : {}),
  };
}

/** Parses and validates one JSON Session request. Unknown fields fail loudly. */
export function parseSessionRequest(content: string): SessionInboxRequest {
  let data: unknown;
  try { data = JSON.parse(content); } catch { invalid('Request must be valid JSON.'); }
  if (!object(data)) invalid('Request must be a JSON object.');
  for (const key of Object.keys(data)) if (!FIELDS.has(key)) invalid(`Unknown field: ${key}.`);
  if (data.version !== 1) invalid('"version" must be 1.');
  const workspaceId = optionalString(data.workspaceId, 'workspaceId');
  const cwd = optionalString(data.cwd, 'cwd');
  if (cwd !== undefined && (!isAbsolute(cwd) || cwd.includes('\0'))) invalid('"cwd" must be an absolute path.');
  if ((workspaceId === undefined) === (cwd === undefined)) invalid('Provide exactly one of "workspaceId" or "cwd".');
  const taskId = data.taskId === undefined ? undefined : nonEmpty(data.taskId, 'taskId');
  if (taskId !== undefined && !UUID.test(taskId)) invalid('"taskId" must be a task UUID.');
  const title = optionalString(data.title, 'title');
  if (title !== undefined && title.length > 200) invalid('"title" must be at most 200 characters.');
  const prompt = data.prompt === undefined ? undefined : data.prompt;
  if (prompt !== undefined && typeof prompt !== 'string') invalid('"prompt" must be a string.');
  return {
    version: 1,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(data.agentPreset !== undefined ? { agentPreset: nonEmpty(data.agentPreset, 'agentPreset') } : {}),
    ...(data.model !== undefined ? { model: parseModel(data.model) } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(prompt !== undefined && prompt !== '' ? { prompt } : {}),
  };
}

/** Lists valid request files at the top level of the inbox; malformed files stay with diagnostics. */
export async function scanSessionInbox(directory: string): Promise<{ entries: SessionInboxEntry[]; diagnostics: Diagnostic[] }> {
  const result: { entries: SessionInboxEntry[]; diagnostics: Diagnostic[] } = { entries: [], diagnostics: [] };
  if (!directory) return result;
  let names: string[];
  try { names = (await readdir(directory)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result; throw error; }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const path = join(directory, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      if (info.size > MAX_REQUEST) throw new TaskError('file_too_large', `Request exceeds ${MAX_REQUEST} bytes.`);
      let content: string;
      try { content = utf8.decode(await readFile(path)); }
      catch (error) { if (error instanceof TypeError) throw new TaskError('invalid_encoding', 'Request must contain UTF-8 text.'); throw error; }
      result.entries.push({ name, path, content, version: hash(content), request: parseSessionRequest(content) });
    } catch (error) {
      result.diagnostics.push({ path, message: messageOf(error) });
    }
  }
  return result;
}
