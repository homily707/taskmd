import { Buffer } from 'node:buffer';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyBetween } from 'fractional-indexing';
import { TaskError, type AssetRef, type Diagnostic, type MetadataState, type TaskMetadata } from '../types.js';
import { hash, parseTask } from './document.js';
import { analyze } from './graph.js';

// Bump this version when parser semantics or the metadata representation change.
const VERSION = 1;
const MAX_CACHE = 64 * 1024 * 1024;
const MAX_DOCUMENT = 1024 * 1024;
const READ_ATTEMPTS = 3;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/;
const DIGEST = /^[0-9a-f]{64}$/;
const METADATA_KEYS = ['schema', 'id', 'title', 'status', 'parent', 'blocked_by', 'order', 'repo', 'assets', 'archived'];

// Decimal strings preserve nanoseconds and inode/device precision in JSON.
type Stamp = [size: string, mtimeNs: string, ctimeNs: string, ino: string, dev: string, mode: string];
interface FileResult {
  fingerprint: string;
  task: TaskMetadata | null;
  diagnostics: Diagnostic[];
}
interface Entry extends FileResult {
  name: string;
  stamp: Stamp;
}
interface IndexIO {
  readText(path: string, limit?: number): Promise<string>;
  atomicWrite(path: string, content: string): Promise<void>;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim();
}
function validAsset(value: unknown): value is AssetRef {
  if (!object(value) || !nonempty(value.path)
    || /^[\\/]/.test(value.path) || /^[A-Za-z]:/.test(value.path)
    || value.path.includes('\0') || value.path.split(/[\\/]/).includes('..')
    || (value.share !== 'task' && value.share !== 'root')) return false;
  return value.kind === 'shared'
    ? keys(value, ['kind', 'path', 'share'])
    : value.kind === 'repo' && keys(value, ['kind', 'path', 'share', 'repo']) && id(value.repo);
}
function validMetadata(value: unknown): value is TaskMetadata {
  if (!object(value) || !keys(value, METADATA_KEYS) || value.schema !== 1
    || !id(value.id) || !nonempty(value.title)
    || !['todo', 'in_progress', 'done', 'canceled'].includes(value.status as string)
    || !(value.parent === null || id(value.parent))
    || !Array.isArray(value.blocked_by) || !value.blocked_by.every(id)
    || typeof value.order !== 'string' || !/^[A-Za-z][0-9A-Za-z]+$/.test(value.order)
    || !(value.repo === null || id(value.repo))
    || !Array.isArray(value.assets) || !value.assets.every(validAsset)
    || typeof value.archived !== 'boolean') return false;
  try { generateKeyBetween(value.order, null); }
  catch { return false; }
  return true;
}
function validStamp(value: unknown): value is Stamp {
  if (!Array.isArray(value) || value.length !== 6
    || !value.every((part, index) => typeof part === 'string' && part.length <= 40
      && (index === 1 || index === 2 ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/).test(part))) return false;
  // Only regular, non-symlink entries may be reused.
  return (BigInt(value[5]) & 0o170000n) === 0o100000n;
}
function validDiagnostic(value: unknown, taskId: string): value is Diagnostic {
  return object(value)
    && (keys(value, ['code', 'message', 'severity']) || keys(value, ['code', 'message', 'severity', 'taskId']))
    && nonempty(value.code) && typeof value.message === 'string'
    && (value.severity === 'error' || value.severity === 'warning')
    && (!Object.hasOwn(value, 'taskId') || value.taskId === taskId);
}
function validEntry(value: unknown): value is Entry {
  if (!object(value) || !keys(value, ['name', 'stamp', 'fingerprint', 'task', 'diagnostics'])
    || typeof value.name !== 'string' || !value.name.toLowerCase().endsWith('.md')
    || /[\/\0]/.test(value.name) || !validStamp(value.stamp)
    || typeof value.fingerprint !== 'string' || !DIGEST.test(value.fingerprint)
    || !Array.isArray(value.diagnostics)
    || !value.diagnostics.every(issue => validDiagnostic(issue, (value.name as string).slice(0, -3)))) return false;
  if (value.task === null) {
    return value.diagnostics.length === 1 && value.diagnostics[0].severity === 'error';
  }
  return FILENAME.test(value.name) && validMetadata(value.task) && value.task.id === value.name.slice(0, -3)
    && value.diagnostics.every(issue => issue.code === 'UNKNOWN_FIELD' && issue.severity === 'warning');
}

async function loadIndex(path: string, root: string, io: IndexIO): Promise<Map<string, Entry> | null> {
  try {
    const source = await io.readText(path, MAX_CACHE);
    if (Buffer.byteLength(source, 'utf8') > MAX_CACHE) return null;
    const value: unknown = JSON.parse(source);
    if (!object(value) || !keys(value, ['payload', 'checksum']) || !object(value.payload)
      || !keys(value.payload, ['version', 'root', 'entries'])
      || value.payload.version !== VERSION || value.payload.root !== root
      || !Array.isArray(value.payload.entries)
      || typeof value.checksum !== 'string' || !DIGEST.test(value.checksum)) return null;
    const entries = new Map<string, Entry>();
    for (const entry of value.payload.entries) {
      if (!validEntry(entry) || entries.has(entry.name)) return null;
      entries.set(entry.name, entry);
    }
    if (hash(JSON.stringify(value.payload)) !== value.checksum) return null;
    return entries;
  } catch {
    // Missing, corrupt, unsupported, oversized, or inaccessible caches are disposable.
    return null;
  }
}

async function writeIndex(path: string, root: string, entries: Entry[], io: IndexIO): Promise<void> {
  try {
    // Bound serialization before joining the complete payload, including envelope overhead.
    const prefix = `{"version":${VERSION},"root":${JSON.stringify(root)},"entries":[`;
    const pieces = [prefix];
    let bytes = Buffer.byteLength(prefix, 'utf8') + 128;
    if (bytes > MAX_CACHE) return;
    for (const entry of entries) {
      const encoded = JSON.stringify(entry);
      bytes += Buffer.byteLength(encoded, 'utf8') + 1;
      if (bytes > MAX_CACHE) return;
      if (pieces.length > 1) pieces.push(',');
      pieces.push(encoded);
    }
    pieces.push(']}');
    const payload = pieces.join('');
    const content = `{"payload":${payload},"checksum":"${hash(payload)}"}`;
    if (Buffer.byteLength(content, 'utf8') <= MAX_CACHE) await io.atomicWrite(path, content);
  } catch {
    // Serialization and persistence failures must never turn a successful query into a failure.
  }
}

async function stampOf(path: string): Promise<Stamp> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new TaskError('invalid_file', `Not a regular file: ${path}`, 'Use a regular UTF-8 file.');
  }
  return [info.size, info.mtimeNs, info.ctimeNs, info.ino, info.dev, info.mode].map(String) as Stamp;
}
function sameStamp(a: Stamp, b: Stamp): boolean {
  return a.every((part, index) => part === b[index]);
}
function failed(name: string, error: unknown): FileResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return {
    fingerprint: `unreadable:${code ?? message}`,
    task: null,
    diagnostics: [{ code: error instanceof TaskError ? error.code : 'invalid_file', message: `${name}: ${message}`, severity: 'error', taskId: name.slice(0, -3) }],
  };
}
function parseMetadata(name: string, content: string): FileResult {
  const fingerprint = hash(content);
  const taskId = name.slice(0, -3);
  if (!FILENAME.test(name)) {
    return { fingerprint, task: null, diagnostics: [{ code: 'stray_file', message: `Unrecognized task filename: ${name}`, taskId, severity: 'error' }] };
  }
  try {
    const parsed = parseTask(content);
    if (parsed.task.id !== taskId) throw new TaskError('id_mismatch', `${name} contains task ${parsed.task.id}`, 'Restore the ID or filename.');
    const { body: _body, ...task } = parsed.task;
    return { fingerprint, task, diagnostics: parsed.diagnostics };
  } catch (error) {
    return { ...failed(name, error), fingerprint };
  }
}

/**
 * Read-only metadata acceleration; Markdown remains authoritative. The caller must
 * hold the Store writer lock and supply its bounded, regular-file/no-follow reader
 * and atomic writer. Mutation validation and check must continue using strict scans.
 */
export async function readMetadataIndex(canonicalRoot: string, localDirectory: string, io: IndexIO): Promise<MetadataState> {
  const path = join(localDirectory, 'index.json');
  const cached = await loadIndex(path, canonicalRoot, io);
  const directory = join(canonicalRoot, 'tasks');
  const names = (await readdir(directory)).filter(name => name.toLowerCase().endsWith('.md')).sort();
  const entries: Entry[] = [];
  const fingerprints: [string, string][] = [];
  const tasks: TaskMetadata[] = [];
  const diagnostics: Diagnostic[] = [];
  let changed = cached === null;
  for (const name of names) {
    const file = join(directory, name);
    let result: FileResult;
    let entry: Entry | undefined;
    try {
      let before = await stampOf(file);
      const previous = cached?.get(name);
      if (previous && sameStamp(before, previous.stamp)) {
        entry = previous;
      } else {
        for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
          const content = await io.readText(file, MAX_DOCUMENT);
          const after = await stampOf(file);
          if (sameStamp(before, after)) {
            entry = { name, stamp: after, ...parseMetadata(name, content) };
            break;
          }
          before = after;
        }
      }
      if (!entry) throw new TaskError('unstable_file', 'Task file changed repeatedly while being read.', 'Retry after the external editor finishes.');
      result = entry;
      entries.push(entry);
      if (entry !== previous) changed = true;
    } catch (error) {
      // Do not persist transient read/stat errors or unstable content. In particular,
      // an invalid replacement must never leave a previously valid task in results.
      result = failed(name, error);
    }
    fingerprints.push([name, result.fingerprint]);
    if (result.task) tasks.push(result.task);
    diagnostics.push(...result.diagnostics);
  }
  if (cached && cached.size !== entries.length) changed = true;
  const graph = analyze(tasks);
  // Match Store.scan: hash UTF-8 content, then hash sorted [filename, fingerprint] pairs.
  const state: MetadataState = {
    schemaVersion: 1,
    revision: hash(JSON.stringify(fingerprints.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))),
    tasks,
    diagnostics: [...diagnostics, ...graph.diagnostics],
    ready: graph.ready,
  };
  if (changed) await writeIndex(path, canonicalRoot, entries, io);
  return state;
}
