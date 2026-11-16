import { constants } from 'node:fs';
import { link, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskError, type Attachment, type CreateTaskInput, type Diagnostic, type HomeSettings, type InboxEntry, type State, type Task, type TaskChanges, type TaskRecord, type TaskSessionBinding } from '../types.js';
import { createDocument, hash, isManaged, MAX_DOCUMENT, parseInboxDocument, parseTask, updateDocument, UUID, validateChanges, validateId, validateTask } from './document.js';

const defaults: HomeSettings = { homeDirectory: '', homeWorkspaceId: null, tasksDirectory: 'tasks' };
/** Only files placed in this directory below the task directory trigger import and Session launch. */
export const INBOX_DIRECTORY = 'inbox';
const MAX_LOCAL = 4 * 1024 * 1024;
const MAX_ATTACHMENT = 8 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type BindingData = Record<string, TaskSessionBinding[]>;
// All instances share the small local mutation queue, including JSON read/modify/write.
// External editors are checked immediately before committing, but cannot join this queue.
let pending: Promise<unknown> = Promise.resolve();
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation, operation);
  pending = result.catch(() => {});
  return result;
}
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function within(root: string, target: string): boolean {
  const suffix = relative(root, target);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}
const ID_LENGTHS = [8, 12, 16, 20, 32, 36] as const;
const MAX_TITLE_BYTES = 180;
function clipBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = '';
  for (const char of value) {
    if (Buffer.byteLength(result + char) > maxBytes) break;
    result += char;
  }
  return result;
}
/** Stable, human-readable filename; the frontmatter UUID remains the task identity. */
export function taskFilename(title: string, id: string, idLength = 8): string {
  const cleaned = title
    .replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const clipped = clipBytes(cleaned, MAX_TITLE_BYTES).replace(/[. ]+$/g, '');
  const base = clipped && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clipped) ? clipped : `_${clipped || 'task'}`;
  return `${base}--${id.slice(0, idLength)}.md`;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function settingsOf(value: unknown): HomeSettings {
  if (!object(value) || typeof value.homeDirectory !== 'string'
    || (value.homeDirectory !== '' && (!isAbsolute(value.homeDirectory) || value.homeDirectory.includes('\0')))
    || !(value.homeWorkspaceId === null || typeof value.homeWorkspaceId === 'string')) {
    throw new TaskError('invalid_settings', 'Home must be an absolute workspace directory.');
  }
  const tasksDirectory = value.tasksDirectory ?? 'tasks';
  if (typeof tasksDirectory !== 'string' || !tasksDirectory.trim() || isAbsolute(tasksDirectory)
    || /[\\\0:]/.test(tasksDirectory) || tasksDirectory.split('/').some(part => part === '..' || part === '.')) {
    throw new TaskError('invalid_settings', 'Tasks directory must be a relative directory within Home.');
  }
  return { homeDirectory: value.homeDirectory ? resolve(value.homeDirectory) : '',
    homeWorkspaceId: value.homeWorkspaceId, tasksDirectory };
}
async function bytes(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new TaskError('invalid_file', `Not a regular file: ${path}`);
    if (info.size > limit) throw new TaskError('file_too_large', `File exceeds ${limit} bytes: ${path}`);
    const buffer = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let count = 0;
    while (count < buffer.length) {
      const result = await file.read(buffer, count, buffer.length - count, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > info.size) throw new TaskError('version_conflict', 'File changed while reading.');
    return buffer.subarray(0, count);
  } finally { await file.close(); }
}
async function text(path: string, limit: number): Promise<string> {
  try { return utf8.decode(await bytes(path, limit)); }
  catch (error) {
    if (error instanceof TypeError) throw new TaskError('invalid_encoding', 'File must contain UTF-8 text.');
    throw error;
  }
}
async function json(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await text(path, MAX_LOCAL)) as unknown; }
  catch (error) {
    if (code(error) === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new TaskError('invalid_local_data', `Invalid JSON: ${path}`);
    throw error;
  }
}
async function atomicWrite(path: string, content: string, beforeCommit?: () => Promise<void>): Promise<void> {
  const temp = join(dirname(path), `.taskmd-${randomUUID()}.tmp`);
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(content, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await beforeCommit?.();
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(error => { if (code(error) !== 'ENOENT') throw error; });
  }
}
async function writeJson(path: string, data: unknown): Promise<void> {
  const content = `${JSON.stringify(data, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_LOCAL) throw new TaskError('file_too_large', 'Local settings or bindings exceed 4 MiB.');
  await atomicWrite(path, content);
}
function parentError(task: Task, tasks: Task[]): string | undefined {
  const byId = new Map(tasks.map(item => [item.id, item]));
  const seen = new Set([task.id]);
  let parent = task.parent;
  while (parent !== null) {
    if (seen.has(parent)) return 'Parent hierarchy must not contain cycles.';
    seen.add(parent);
    const ancestor = byId.get(parent);
    if (!ancestor) return `Parent ${parent} does not exist.`;
    parent = ancestor.parent;
  }
  return undefined;
}
function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || value.includes('\0')) {
    throw new TaskError('invalid_session', 'Session ID must be a nonempty string of at most 500 characters.');
  }
}

export class TaskFiles {
  private readonly localDirectory: string;
  private settings: HomeSettings = { ...defaults };
  private home = '';
  private directory = '';
  private inbox = '';
  private readonly inboxIds = new Map<string, string>();
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private fingerprint?: string;
  private polling = false;
  private closed = false;

  constructor(options: { localDirectory: string }) {
    if (!options.localDirectory || !isAbsolute(options.localDirectory)) throw new TaskError('invalid_settings', 'Local directory must be absolute.');
    this.localDirectory = resolve(options.localDirectory);
  }
  async init(): Promise<void> {
    await serialized(async () => {
      await this.prepareLocal();
      try { await this.prepare(); this.fingerprint = await this.snapshotFingerprint(); }
      catch (error) { this.fingerprint = `error:${(error as Error).message}`; }
      // Keep configuration available when an existing Home is offline or invalid.
      // Reads still report the error; only an explicit configure changes Home.
    });
    if (this.closed || this.timer) return;
    // Content polling also observes atomic replacements and directory recreation.
    this.timer = setInterval(() => {
      if (this.polling || this.closed || !this.listeners.size) return;
      this.polling = true;
      void serialized(async () => {
        if (this.closed) return;
        let next: string;
        try { await this.prepare(); next = await this.snapshotFingerprint(); }
        catch (error) { next = `error:${(error as Error).message}`; }
        if (next !== this.fingerprint) { this.fingerprint = next; this.notify(); }
      }).finally(() => { this.polling = false; });
    }, 500);
    this.timer.unref();
  }
  close(): void { this.closed = true; clearInterval(this.timer); this.timer = undefined; this.listeners.clear(); }
  subscribe(listener: () => void): () => void {
    if (!this.closed) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private notify(): void {
    if (this.closed) return;
    for (const listener of this.listeners) { try { listener(); } catch { /* A subscriber cannot fail a committed write. */ } }
  }
  private async prepare(): Promise<void> {
    await mkdir(this.localDirectory, { recursive: true, mode: 0o700 });
    this.settings = settingsOf(await json(join(this.localDirectory, 'settings.json')) ?? defaults);
    const paths = await this.paths(this.settings);
    this.home = paths.home;
    this.directory = paths.directory;
    this.inbox = paths.inbox;
  }
  private async paths(settings: HomeSettings): Promise<{ home: string; directory: string; inbox: string }> {
    if (!settings.homeDirectory) return { home: '', directory: '', inbox: '' };
    const home = await realpath(settings.homeDirectory);
    if (!(await stat(home)).isDirectory()) throw new TaskError('invalid_settings', 'Home must be a directory.');
    let directory = home;
    for (const part of settings.tasksDirectory.split('/').filter(Boolean)) {
      const candidate = join(directory, part);
      try { await mkdir(candidate); }
      catch (error) { if (code(error) !== 'EEXIST') throw error; }
      directory = await realpath(candidate);
      if (!within(home, directory) || directory === home || !(await stat(directory)).isDirectory()) {
        throw new TaskError('path_outside_home', 'Tasks directory must resolve within Home.');
      }
    }
    if (directory === home) throw new TaskError('invalid_settings', 'Tasks directory must be below Home.');
    let inbox = directory;
    for (const part of INBOX_DIRECTORY.split('/')) {
      const candidate = join(inbox, part);
      try { await mkdir(candidate); }
      catch (error) { if (code(error) !== 'EEXIST') throw error; }
      inbox = await realpath(candidate);
      if (!within(directory, inbox) || inbox === directory || !(await stat(inbox)).isDirectory()) {
        throw new TaskError('path_outside_home', 'Inbox directory must resolve within the tasks directory.');
      }
    }
    const local = await realpath(this.localDirectory);
    if (within(directory, local) || within(local, directory)) throw new TaskError('invalid_settings', 'Tasks and local settings directories must be separate.');
    return { home, directory, inbox };
  }
  private configured(): void {
    if (!this.directory) throw new TaskError('not_configured', 'Choose a Home workspace first.');
  }
  private async assertDirectory(): Promise<void> {
    const paths = await this.paths(this.settings);
    if (paths.home !== this.home || paths.directory !== this.directory || paths.inbox !== this.inbox) throw new TaskError('path_changed', 'Home or tasks directory changed during the operation.');
  }
  private async scan(): Promise<State> {
    const state: State = { settings: { ...this.settings }, tasks: [], diagnostics: [], inbox: { directory: INBOX_DIRECTORY, pending: 0, diagnostics: [] } };
    if (!this.directory) return state;
    await this.assertDirectory();
    const seen = new Map<string, string>();
    for (const name of (await readdir(this.directory)).sort()) {
      if (!name.endsWith('.md')) continue;
      const path = join(this.directory, name);
      try {
        const content = await text(path, MAX_DOCUMENT);
        if (!isManaged(content)) continue;
        const task = parseTask(content);
        const previous = seen.get(task.id);
        if (previous) throw new TaskError('duplicate_id', `Task ID ${task.id} is also used by ${previous}.`);
        seen.set(task.id, name);
        state.tasks.push({ task, content, version: hash(content), path });
      } catch (error) {
        state.diagnostics.push({ path, message: (error as Error).message });
      }
    }
    state.tasks.sort((a, b) => a.task.order - b.task.order || a.task.id.localeCompare(b.task.id));
    const tasks = state.tasks.map(record => record.task);
    for (const record of state.tasks) {
      const message = parentError(record.task, tasks);
      if (message) state.diagnostics.push({ path: record.path, message });
    }
    return state;
  }
  /** Valid task documents waiting in the inbox; malformed files stay there with diagnostics. */
  private async readInbox(): Promise<{ entries: InboxEntry[]; diagnostics: Diagnostic[] }> {
    const result: { entries: InboxEntry[]; diagnostics: Diagnostic[] } = { entries: [], diagnostics: [] };
    if (!this.inbox) return result;
    let names: string[];
    try { names = (await readdir(this.inbox)).sort(); }
    catch (error) { if (code(error) === 'ENOENT') return result; throw error; }
    for (const name of names) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue;
      const path = join(this.inbox, name);
      try {
        const content = await text(path, MAX_DOCUMENT);
        if (!isManaged(content)) { result.diagnostics.push({ path, message: 'Not a taskmd task.' }); continue; }
        const draft = parseInboxDocument(content);
        const id = draft.id ?? this.inboxIds.get(path) ?? randomUUID();
        if (!draft.id) this.inboxIds.set(path, id);
        const task: Task = {
          id, title: draft.title, ...(draft.summary !== undefined ? { summary: draft.summary } : {}),
          status: draft.status ?? 'todo', parent: draft.parent ?? null,
          order: draft.order ?? 0, archived: draft.archived ?? false, body: draft.body,
        };
        validateTask(task);
        const materialize = draft.id === undefined || draft.status === undefined || draft.parent === undefined
          || draft.order === undefined || draft.archived === undefined;
        result.entries.push({ name, path, content, version: hash(content), task, materialize, autoOrder: draft.order === undefined });
      } catch (error) {
        result.diagnostics.push({ path, message: (error as Error).message });
      }
    }
    return result;
  }
  private async statePrepared(): Promise<State> {
    const state = await this.scan();
    const inbox = await this.readInbox();
    state.inbox = { directory: INBOX_DIRECTORY, pending: inbox.entries.length, diagnostics: inbox.diagnostics };
    return state;
  }
  private async snapshotFingerprint(): Promise<string> {
    const inbox = await this.readInbox();
    return hash(JSON.stringify([
      await this.scan(),
      await this.bindingData(),
      inbox.entries.map(entry => [entry.name, entry.version]),
      inbox.diagnostics.map(item => [item.path, item.message]),
    ]));
  }
  state(): Promise<State> { return serialized(async () => { await this.prepare(); return this.statePrepared(); }); }
  configure(settings: HomeSettings): Promise<State> {
    return serialized(async () => {
      await this.prepareLocal();
      const next = settingsOf(settings);
      const paths = await this.paths(next);
      await writeJson(join(this.localDirectory, 'settings.json'), next);
      this.settings = next; this.home = paths.home; this.directory = paths.directory; this.inbox = paths.inbox;
      const state = await this.statePrepared(); this.notify(); return state;
    });
  }
  private async prepareLocal(): Promise<void> { await mkdir(this.localDirectory, { recursive: true, mode: 0o700 }); }
  /** Filenames are display labels; the frontmatter UUID is the lookup key. */
  private async findPath(id: string): Promise<string> {
    const names = (await readdir(this.directory)).sort();
    const exact = `${id}.md`;
    const short = id.slice(0, 8);
    const candidates = names.filter(name => name.endsWith('.md') && (name === exact || name.includes(short)));
    const inspect = async (name: string): Promise<string | undefined> => {
      const path = join(this.directory, name);
      try {
        const content = await text(path, MAX_DOCUMENT);
        if (isManaged(content) && parseTask(content).id === id) return path;
        if (name === exact || candidates.length === 1) return path;
      } catch { if (name === exact || candidates.length === 1) return path; }
      return undefined;
    };
    for (const name of candidates) {
      const path = await inspect(name);
      if (path) return path;
    }
    for (const name of names) {
      if (!name.endsWith('.md') || candidates.includes(name)) continue;
      const path = await inspect(name);
      if (path) return path;
    }
    throw new TaskError('not_found', 'Task does not exist.');
  }
  private async readCurrent(id: string, expected?: { version: string }): Promise<TaskRecord> {
    this.configured(); validateId(id); await this.assertDirectory();
    const path = await this.findPath(id);
    let content: string;
    try { content = await text(path, MAX_DOCUMENT); }
    catch (error) { if (code(error) === 'ENOENT') throw new TaskError('not_found', 'Task does not exist.'); throw error; }
    const version = hash(content);
    if (expected && expected.version !== version) {
      throw new TaskError('version_conflict', 'Task changed. Reload and merge your draft before saving.', { latestVersion: version });
    }
    if (!isManaged(content)) throw new TaskError('not_found', 'File is not a taskmd task.');
    const task = parseTask(content);
    if (task.id !== id) throw new TaskError('invalid_document', 'Task ID does not match its filename.');
    return { task, content, version, path };
  }
  read(id: string): Promise<TaskRecord> { return serialized(async () => { await this.prepare(); return this.readCurrent(id); }); }
  hasTask(id: string): Promise<boolean> {
    return serialized(async () => {
      await this.prepare();
      if (!this.directory) return false;
      try { await this.readCurrent(id); return true; }
      catch (error) { if (error instanceof TaskError && error.code === 'not_found') return false; throw error; }
    });
  }
  inboxEntries(): Promise<{ entries: InboxEntry[]; diagnostics: Diagnostic[] }> {
    return serialized(async () => { await this.prepare(); return this.readInbox(); });
  }
  /** Moves every valid inbox document into the task directory; a file leaves the inbox only once. */
  importInbox(): Promise<{ imported: TaskRecord[]; diagnostics: Diagnostic[] }> {
    return serialized(async () => {
      await this.prepare(); this.configured();
      const inbox = await this.readInbox();
      const diagnostics = [...inbox.diagnostics];
      if (!inbox.entries.length) return { imported: [], diagnostics };
      const state = await this.scan();
      const existingIds = new Set(state.tasks.map(record => record.task.id));
      const seen = new Set<string>();
      let candidates = inbox.entries.filter(entry => {
        if (seen.has(entry.task.id)) {
          diagnostics.push({ path: entry.path, message: `Task ID ${entry.task.id} is also used by another inbox file.` });
          return false;
        }
        seen.add(entry.task.id);
        if (!existingIds.has(entry.task.id)) return true;
        diagnostics.push({ path: entry.path, message: `Task ID ${entry.task.id} already exists.` });
        return false;
      });
      // A parent may itself be another inbox file; drop invalid candidates until stable.
      for (;;) {
        const tasks = [...state.tasks.map(record => record.task), ...candidates.map(entry => entry.task)];
        const invalid = candidates.filter(entry => parentError(entry.task, tasks));
        if (!invalid.length) break;
        for (const entry of invalid) diagnostics.push({ path: entry.path, message: parentError(entry.task, tasks)! });
        const ids = new Set(invalid.map(entry => entry.task.id));
        candidates = candidates.filter(entry => !ids.has(entry.task.id));
      }
      const nextOrder = new Map<string | null, number>();
      for (const record of state.tasks) nextOrder.set(record.task.parent, Math.max(nextOrder.get(record.task.parent) ?? -1, record.task.order));
      for (const entry of candidates) {
        if (!entry.autoOrder) continue;
        const order = (nextOrder.get(entry.task.parent) ?? -1) + 1;
        entry.task = { ...entry.task, order };
        nextOrder.set(entry.task.parent, order);
      }
      const imported: TaskRecord[] = [];
      for (const entry of candidates) {
        try {
          const file = await this.importFile(entry);
          imported.push({ task: entry.task, content: file.content, version: file.version, path: file.path });
        } catch (error) {
          diagnostics.push({ path: entry.path, message: (error as Error).message });
        }
      }
      if (imported.length) this.notify();
      return { imported, diagnostics };
    });
  }
  private async importFile(entry: InboxEntry): Promise<{ path: string; content: string; version: string }> {
    const content = entry.materialize ? createDocument(entry.task) : entry.content;
    for (const length of ID_LENGTHS) {
      const target = join(this.directory, taskFilename(entry.task.title, entry.task.id, length));
      let created = false;
      try {
        const file = await open(target, 'wx', 0o600);
        created = true;
        try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
        try { await unlink(entry.path); }
        catch (error) { await unlink(target).catch(() => {}); throw error; }
        return { path: target, content, version: hash(content) };
      } catch (error) {
        if (created) await unlink(target).catch(() => {});
        if (code(error) === 'EEXIST') continue;
        throw error;
      }
    }
    throw new TaskError('filename_conflict', 'Could not find a unique task filename.');
  }
  create(input: CreateTaskInput): Promise<TaskRecord> {
    return serialized(async () => {
      await this.prepare(); this.configured();
      if (!object(input) || Object.keys(input).some(key => !['title', 'parent', 'body', 'summary'].includes(key))) throw new TaskError('invalid_document', 'Invalid create input.');
      const state = await this.scan();
      const parent = input.parent ?? null;
      const siblings = state.tasks.filter(record => record.task.parent === parent);
      const order = Math.max(-1, ...siblings.map(record => record.task.order)) + 1;
      const task: Task = { id: randomUUID(), title: input.title, ...(input.summary !== undefined ? { summary: input.summary } : {}),
        parent, status: 'todo', order, archived: false, body: input.body ?? '' };
      const content = createDocument(task);
      this.validateParent(task, state);
      await this.assertDirectory();
      const path = await this.createFile(content, task.title, task.id);
      this.notify();
      return { task, content, version: hash(content), path };
    });
  }
  private async createFile(content: string, title: string, id: string): Promise<string> {
    for (const length of ID_LENGTHS) {
      const path = join(this.directory, taskFilename(title, id, length));
      try {
        const file = await open(path, 'wx', 0o600);
        try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
        return path;
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
      }
    }
    throw new TaskError('filename_conflict', 'Could not find a unique task filename.');
  }
  private validateParent(task: Task, state: State): void {
    const message = parentError(task, [...state.tasks.filter(record => record.task.id !== task.id).map(record => record.task), task]);
    if (message) throw new TaskError('invalid_parent', message);
  }
  private async checkVersion(id: string, expectedVersion: string): Promise<TaskRecord> {
    return this.readCurrent(id, { version: expectedVersion });
  }
  private async writeMoved(currentPath: string, content: string, title: string, id: string, expectedVersion: string): Promise<string> {
    const directory = dirname(currentPath);
    const temp = join(directory, `.taskmd-${randomUUID()}.tmp`);
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(content, 'utf8'); await file.sync(); } finally { await file.close(); }
      await this.checkVersion(id, expectedVersion);
      for (const length of ID_LENGTHS) {
        const target = join(directory, taskFilename(title, id, length));
        if (target === currentPath) {
          await atomicWrite(currentPath, content, async () => { await this.checkVersion(id, expectedVersion); });
          return currentPath;
        }
        try { await link(temp, target); }
        catch (error) { if (code(error) === 'EEXIST') continue; throw error; }
        try { await unlink(currentPath); }
        catch (error) { await unlink(target).catch(() => {}); throw error; }
        return target;
      }
      throw new TaskError('filename_conflict', 'Could not find a unique task filename.');
    } finally { await unlink(temp).catch(error => { if (code(error) !== 'ENOENT') throw error; }); }
  }
  update(id: string, changes: TaskChanges, expectedVersion: string): Promise<TaskRecord> {
    return serialized(async () => {
      await this.prepare(); validateChanges(changes);
      const current = await this.checkVersion(id, expectedVersion);
      const content = updateDocument(current.content, changes);
      const task = parseTask(content);
      this.validateParent(task, await this.scan());
      const path = task.title !== current.task.title
        ? await this.writeMoved(current.path, content, task.title, task.id, expectedVersion)
        : await atomicWrite(current.path, content, async () => { await this.checkVersion(id, expectedVersion); }).then(() => current.path);
      this.notify(); return { task, content, version: hash(content), path };
    });
  }
  /** Deleting a task removes its whole subtree, deepest tasks first. */
  remove(id: string, expectedVersion: string): Promise<string[]> {
    return serialized(async () => {
      await this.prepare();
      let current: TaskRecord;
      try { current = await this.checkVersion(id, expectedVersion); }
      catch (error) {
        if (!(error instanceof TaskError) || error.code !== 'not_found') throw error;
        // A prior deletion may have committed before local binding cleanup failed.
        const data = await this.bindingData(); const key = this.bindingKey();
        data[key] = (data[key] ?? []).filter(binding => binding.taskId !== id);
        await writeJson(join(this.localDirectory, 'bindings.json'), data); this.notify(); return [id];
      }
      const state = await this.scan();
      if (state.diagnostics.length) throw new TaskError('invalid_structure', 'Resolve task diagnostics before deleting; descendants cannot be safely determined.', state.diagnostics);
      const byId = new Map(state.tasks.map(record => [record.task.id, record]!));
      const depthOf = (record: TaskRecord): number => {
        let depth = 0; let parent: string | null = record.task.parent;
        while (parent !== null) { const ancestor = byId.get(parent); if (!ancestor) break; depth += 1; parent = ancestor.task.parent; }
        return depth;
      };
      const doomed = new Set([id]);
      for (let growing = true; growing;) {
        growing = false;
        for (const record of state.tasks) {
          if (record.task.parent !== null && doomed.has(record.task.parent) && !doomed.has(record.task.id)) { doomed.add(record.task.id); growing = true; }
        }
      }
      const ordered = state.tasks.filter(record => doomed.has(record.task.id) && record.task.id !== id)
        .sort((a, b) => depthOf(b) - depthOf(a));
      const data = await this.bindingData();
      const key = this.bindingKey();
      data[key] = (data[key] ?? []).filter(binding => !doomed.has(binding.taskId));
      await this.checkVersion(id, expectedVersion);
      for (const record of ordered) await unlink(record.path);
      await unlink(current.path);
      await writeJson(join(this.localDirectory, 'bindings.json'), data);
      this.notify();
      return [...doomed];
    });
  }
  /** Stable partition key for local state tied to the current task directory. */
  homeKey(): string { return this.directory ? this.bindingKey() : ''; }
  private bindingKey(): string { return hash(this.directory); }
  private async bindingData(): Promise<BindingData> {
    const data = await json(join(this.localDirectory, 'bindings.json')) ?? {};
    if (!object(data)) throw new TaskError('invalid_local_data', 'Bindings must be a JSON object.');
    for (const [key, items] of Object.entries(data)) {
      if (!/^[a-f0-9]{64}$/.test(key) || !Array.isArray(items) || items.some(item => !object(item)
        || typeof item.taskId !== 'string' || !UUID.test(item.taskId) || typeof item.sessionId !== 'string'
        || !item.sessionId.trim() || typeof item.createdAt !== 'string'
        || (item.lastOpenedAt !== undefined && typeof item.lastOpenedAt !== 'string'))) {
        throw new TaskError('invalid_local_data', 'Invalid session bindings.');
      }
    }
    return data as BindingData;
  }
  bindings(taskId?: string): Promise<TaskSessionBinding[]> {
    return serialized(async () => {
      await this.prepare(); if (!this.directory) return [];
      if (taskId !== undefined) validateId(taskId);
      return ((await this.bindingData())[this.bindingKey()] ?? []).filter(item => taskId === undefined || item.taskId === taskId);
    });
  }
  /** The Task that currently owns one Session in this Home, if any. */
  taskForSession(id: string): Promise<string | undefined> {
    return serialized(async () => {
      await this.prepare(); if (!this.directory) return undefined;
      assertSessionId(id);
      return (await this.bindingData())[this.bindingKey()]?.find(item => item.sessionId === id)?.taskId;
    });
  }
  bind(taskId: string, id: string): Promise<void> {
    return serialized(async () => {
      await this.prepare(); await this.readCurrent(taskId); assertSessionId(id);
      const data = await this.bindingData(); const key = this.bindingKey(); const items = data[key] ?? [];
      const previous = items.find(item => item.sessionId === id);
      if (previous?.taskId === taskId) return;
      data[key] = [...items.filter(item => item.sessionId !== id), { taskId, sessionId: id, createdAt: new Date().toISOString() }];
      await writeJson(join(this.localDirectory, 'bindings.json'), data); this.notify();
    });
  }
  unbind(taskId: string, id: string): Promise<void> {
    return serialized(async () => {
      await this.prepare(); this.configured(); validateId(taskId); assertSessionId(id);
      const data = await this.bindingData(); const key = this.bindingKey();
      data[key] = (data[key] ?? []).filter(item => item.taskId !== taskId || item.sessionId !== id);
      await writeJson(join(this.localDirectory, 'bindings.json'), data); this.notify();
    });
  }
  touch(id: string): Promise<boolean> {
    return serialized(async () => {
      await this.prepare(); assertSessionId(id); if (!this.directory) return false;
      const data = await this.bindingData();
      const binding = (data[this.bindingKey()] ?? []).find(item => item.sessionId === id);
      if (!binding) return false;
      binding.lastOpenedAt = new Date().toISOString();
      await writeJson(join(this.localDirectory, 'bindings.json'), data); this.notify(); return true;
    });
  }
  attachment(id: string, href: string): Promise<Attachment> {
    return serialized(async () => {
      await this.prepare(); const task = await this.readCurrent(id);
      if (typeof href !== 'string' || !href) throw new TaskError('invalid_attachment', 'Attachment must be a relative path.');
      let pathname: string;
      try { pathname = decodeURIComponent(href.split(/[?#]/, 1)[0]!); }
      catch { throw new TaskError('invalid_attachment', 'Invalid attachment path encoding.'); }
      if (!pathname || isAbsolute(pathname) || /^[a-z][a-z0-9+.-]*:/i.test(pathname) || /[\\\0]/.test(pathname)) {
        throw new TaskError('invalid_attachment', 'Attachment must be a relative path.');
      }
      const candidate = resolve(dirname(task.path), pathname);
      if (!within(this.home, candidate)) throw new TaskError('path_outside_home', 'Attachment must stay within Home.');
      const path = await realpath(candidate);
      if (!within(this.home, path)) throw new TaskError('path_outside_home', 'Attachment symlink escapes Home.');
      await this.assertDirectory();
      const extension = extname(path).toLowerCase();
      const images: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
      const texts: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.log': 'text/plain', '.yaml': 'text/plain', '.yml': 'text/plain' };
      const mime = images[extension] ?? texts[extension];
      if (!mime) throw new TaskError('unsupported_attachment', 'Supported attachments are raster images and text files.');
      const data = await bytes(path, MAX_ATTACHMENT);
      if (images[extension]) return { path, mime, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
      let content: string;
      try { content = utf8.decode(data); } catch { throw new TaskError('invalid_encoding', 'Text attachment must contain UTF-8.'); }
      return { path, mime, content };
    });
  }
}
