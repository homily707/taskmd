import { constants, watch, type FSWatcher } from 'node:fs';
import { mkdir, open, rename, unlink, lstat, realpath, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { generateKeyBetween } from 'fractional-indexing';
import { TaskError, type Task, type TaskRecord, type State, type Diagnostic, type Plan, type ApplyResult, type TaskSessionBinding, type TaskSessionBindingFilter } from '../types.js';
import { hash, parseTask, createDocument, updateDocument, validateId } from './document.js';
import { analyze, descendants, executionBlockers, deletionBlockers } from './graph.js';
import { configPath, resolveConfiguration, within, withConfigurationLock } from './config.js';
import { readMetadataIndex } from './metadata-index.js';

const MAX_DOCUMENT = 1024 * 1024;
const MAX_PLAN = 16 * 1024 * 1024;
const MAX_JOURNAL = 64 * 1024 * 1024;
const patchKeys = new Set(['title', 'status', 'parent', 'blocked_by', 'order', 'repo', 'assets', 'archived', 'body']);
const terminal = new Set(['done', 'canceled']);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

interface Snapshot {
  records: Map<string, TaskRecord>;
  contents: Map<string, string>;
  fingerprints: Map<string, string>;
  diagnostics: Diagnostic[];
  revision: string;
}
interface Entry { id: string; before: string | null; after: string | null }
interface Receipt { digest: string; result: ApplyResult }
interface Journal { schema: 1; requestId: string; digest: string; entries: Entry[]; result: ApplyResult }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validResult(value: unknown): value is ApplyResult {
  return object(value) && value.schemaVersion === 1 && typeof value.requestId === 'string'
    && typeof value.revision === 'string' && object(value.ids) && object(value.versions)
    && Object.values(value.ids).every(id => typeof id === 'string')
    && Object.values(value.versions).every(version => typeof version === 'string');
}
function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}
function conflict(message: string, details?: unknown): never {
  throw new TaskError('version_conflict', message, 'Read the current state, merge your changes, and retry with its version.', details);
}
/** Stable identity of one diagnostic, used to tell pre-existing defects from new ones. */
function issueKey(issue: Diagnostic): string {
  return `${issue.code}\u0000${issue.taskId ?? ''}\u0000${issue.message}`;
}
function revisionOf(fingerprints: Map<string, string>): string {
  return hash(JSON.stringify([...fingerprints].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}
async function regularDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TaskError('invalid_path', `Not a regular directory: ${path}`, 'Choose a directory without symlinked task or metadata folders.');
}
async function readText(path: string, limit = MAX_DOCUMENT): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new TaskError('invalid_file', `Not a regular file: ${path}`, 'Use a regular UTF-8 file.');
    if (info.size > limit) throw new TaskError('file_too_large', `File exceeds ${limit} bytes: ${path}`, 'Reduce the file size.');
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const result = await handle.read(bytes, count, bytes.length - count, null);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    if (count > limit) throw new TaskError('file_too_large', `File exceeds ${limit} bytes: ${path}`, 'Reduce the file size.');
    try { return utf8.decode(bytes.subarray(0, count)); }
    catch { throw new TaskError('invalid_encoding', `File is not UTF-8: ${path}`, 'Save the file as UTF-8.'); }
  } finally { await handle.close(); }
}
async function maybeText(path: string, limit = MAX_DOCUMENT): Promise<string | null> {
  try { return await readText(path, limit); }
  catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
}
async function syncDirectory(path: string): Promise<void> {
  // Windows cannot open directories for fsync. File handles are still synced.
  if (process.platform === 'win32') return;
  const directory = await open(path, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = join(dirname(path), `.taskmd-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
    await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
function json<T>(source: string, label: string): T {
  try { return JSON.parse(source) as T; }
  catch { throw new TaskError('invalid_local_data', `Invalid JSON in ${label}`, 'Preserve the file and repair it before retrying.'); }
}

/**
 * Execution-rule violations of one task graph, keyed by the task they belong to.
 *
 * Entries are structural, so the same violation can be recognized before and
 * after a plan: an apply may not *introduce* one, while a graph already carrying
 * a violation (for example after a manual Markdown edit) stays repairable.
 */
function ruleViolations(tasks: Task[]): Map<string, Map<string, Diagnostic>> {
  const result = new Map<string, Map<string, Diagnostic>>();
  const add = (taskId: string, key: string, issue: Diagnostic) => {
    const entries = result.get(taskId) ?? new Map<string, Diagnostic>();
    entries.set(key, issue);
    result.set(taskId, entries);
  };
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parent === null) continue;
    children.set(task.parent, [...(children.get(task.parent) ?? []), task]);
  }
  for (const task of tasks) {
    if (task.status === 'in_progress' || task.status === 'done') {
      for (const blocker of executionBlockers(tasks, task.id)) {
        add(task.id, `blocker\u0000${blocker.taskId}\u0000${blocker.dependencyId ?? ''}\u0000${blocker.message}`, {
          code: task.status === 'done' ? 'not_complete' : 'execution_blocked',
          message: blocker.message, severity: 'error', taskId: task.id,
        });
      }
    }
    if (task.status === 'done') {
      for (const child of children.get(task.id) ?? []) {
        if (terminal.has(child.status)) continue;
        add(task.id, `unfinished-child\u0000${child.id}`, {
          code: 'not_complete',
          message: `Completed task ${task.title} (${task.id}) has unfinished child ${child.title} (${child.id}); reopen it explicitly.`,
          severity: 'error', taskId: task.id,
        });
      }
    }
  }
  return result;
}

/** Provider written for rows that predate the multi-provider field. */
const LEGACY_PROVIDER = 'dsh';
const DEFAULT_PROVIDER = 'dsh';
const MAX_SESSION_ID = 500;

/** Optional identity overrides; omitting them scopes a write to this machine. */
export interface SessionWriteOptions {
  provider?: string;
  instanceId?: string;
}

function sessionProvider(provider: string | undefined): string {
  if (provider === undefined) return DEFAULT_PROVIDER;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 100) {
    throw new TaskError('invalid_provider', 'Invalid provider.', `Use a provider such as ${DEFAULT_PROVIDER}.`);
  }
  return provider;
}

function checkSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > MAX_SESSION_ID) {
    throw new TaskError('invalid_session', 'Invalid session ID.', 'Provide a valid DSH session ID.');
  }
}

export class Store {
  readonly root: string;
  private canonicalRoot = '';
  private local = '';
  private instanceId?: string;
  private ready?: Promise<void>;
  private watchers = new Set<FSWatcher>();
  private listeners = new Set<() => void>();
  private debounce?: ReturnType<typeof setTimeout>;
  private watching?: Promise<void>;
  private watchGeneration = 0;

  private readonly localRoot: string;
  private readonly storeOverride?: string;

  constructor(options: { root?: string } = {}) {
    this.storeOverride = options.root;
    const { values } = resolveConfiguration(options.root);
    this.root = values.store;
    this.localRoot = values.root;
  }

  private assertConfiguration(): void {
    const { values } = resolveConfiguration(this.storeOverride);
    if (values.root !== this.localRoot || values.store !== this.root) {
      throw new TaskError('config_changed', 'The taskmd storage configuration changed.', 'Retry the command or restart the taskmd service/plugin to use the new paths.');
    }
  }

  private async prepare(): Promise<void> {
    if (!this.ready) this.ready = (async () => {
      await mkdir(this.root, { recursive: true });
      this.canonicalRoot = await realpath(this.root);
      await regularDirectory(this.localRoot);
      const canonicalLocal = await realpath(this.localRoot);
      const canonicalConfig = await realpath(dirname(configPath()));
      if (within(this.canonicalRoot, canonicalLocal) || within(this.canonicalRoot, canonicalConfig)
        || within(join(canonicalLocal, 'local'), this.canonicalRoot)) {
        throw new TaskError('overlapping_paths', 'Task storage must be separate from local state and configuration.', 'Use a cloud folder for store and a local folder for root.');
      }
      await regularDirectory(join(this.canonicalRoot, 'tasks'));
      await regularDirectory(join(this.canonicalRoot, 'assets'));
      await regularDirectory(join(canonicalLocal, 'local'));
      this.local = join(canonicalLocal, 'local', hash(this.canonicalRoot));
      await regularDirectory(this.local);
      await regularDirectory(join(this.local, 'receipts'));
    })().catch(error => { this.ready = undefined; throw error; });
    await this.ready;
  }

  private taskPath(id: string): string {
    validateId(id);
    return join(this.canonicalRoot, 'tasks', `${id}.md`);
  }

  private async locked<T>(operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
    return withConfigurationLock(async assertConfigurationHeld => {
      this.assertConfiguration();
      await this.prepare();
      let compromised: Error | undefined;
      let release: () => Promise<void>;
      try {
        release = await lockfile.lock(this.canonicalRoot, {
          realpath: false,
          lockfilePath: join(this.local, 'writer.lock'),
          stale: 30_000,
          update: 5_000,
          retries: { retries: 50, factor: 1, minTimeout: 100, maxTimeout: 100 },
          onCompromised: error => { compromised = error; },
        });
      } catch (error) {
        throw new TaskError('store_busy', `Cannot lock store: ${(error as Error).message}`, 'Wait for the other taskmd writer and retry.');
      }
      const assertHeld = () => {
        assertConfigurationHeld();
        if (compromised) throw new TaskError('lock_lost', compromised.message, 'Stop other writers and retry to recover the pending transaction.');
      };
      try {
        assertHeld();
        await this.recover(assertHeld);
        assertHeld();
        return await operation(assertHeld);
      } finally { await release(); }
    });
  }

  async init(): Promise<{ root: string }> {
    return this.locked(async () => ({ root: this.canonicalRoot }));
  }

  private async scan(): Promise<Snapshot> {
    const records = new Map<string, TaskRecord>();
    const contents = new Map<string, string>();
    const fingerprints = new Map<string, string>();
    const diagnostics: Diagnostic[] = [];
    const names = (await readdir(join(this.canonicalRoot, 'tasks'))).filter(name => name.toLowerCase().endsWith('.md')).sort();
    for (const name of names) {
      const id = name.slice(0, -3);
      try {
        const content = await readText(join(this.canonicalRoot, 'tasks', name));
        fingerprints.set(name, hash(content));
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(name)) {
          diagnostics.push({ code: 'stray_file', message: `Unrecognized task filename: ${name}`, taskId: id, severity: 'error' });
          continue;
        }
        contents.set(id, content);
        const parsed = parseTask(content);
        if (parsed.task.id !== id) throw new TaskError('id_mismatch', `${name} contains task ${parsed.task.id}`, 'Restore the ID or filename.');
        records.set(id, { task: parsed.task, content, version: hash(content) });
        diagnostics.push(...parsed.diagnostics);
      } catch (error) {
        if (!fingerprints.has(name)) fingerprints.set(name, `unreadable:${errorCode(error) ?? (error as Error).message}`);
        diagnostics.push({ code: error instanceof TaskError ? error.code : 'invalid_file', message: `${name}: ${(error as Error).message}`, severity: 'error', taskId: id });
      }
    }
    return { records, contents, fingerprints, diagnostics, revision: revisionOf(fingerprints) };
  }

  /** A disposable, stat-validated index for metadata-only display queries. */
  async metadataState() {
    return this.locked(async assertHeld => {
      const state = await readMetadataIndex(this.canonicalRoot, this.local, {
        readText,
        atomicWrite: async (path, content) => {
          assertHeld();
          await atomicWrite(path, content);
        },
      });
      assertHeld();
      return state;
    });
  }

  async state(): Promise<State> {
    return this.locked(async () => {
      const snapshot = await this.scan();
      const tasks = [...snapshot.records.values()].map(record => record.task);
      const graph = analyze(tasks);
      return { schemaVersion: 1, revision: snapshot.revision, tasks, diagnostics: [...snapshot.diagnostics, ...graph.diagnostics], ready: graph.ready };
    });
  }

  async read(id: string): Promise<TaskRecord> {
    return this.locked(async () => {
      const content = await maybeText(this.taskPath(id));
      if (content === null) throw new TaskError('task_not_found', `Task not found: ${id}`, 'Use list to find a task ID.');
      const { task } = parseTask(content);
      if (task.id !== id) throw new TaskError('id_mismatch', `Task file ${id} contains ${task.id}`, 'Repair the task ID or filename.');
      return { task, content, version: hash(content) };
    });
  }

  private receiptPath(requestId: string): string { return join(this.local, 'receipts', `${hash(requestId)}.json`); }

  private async recover(assertHeld: () => void): Promise<void> {
    const pendingPath = join(this.local, 'pending.json');
    const source = await maybeText(pendingPath, MAX_JOURNAL);
    if (source === null) return;
    const journal = json<Journal>(source, pendingPath);
    if (!object(journal) || journal.schema !== 1 || typeof journal.requestId !== 'string' || typeof journal.digest !== 'string' || !Array.isArray(journal.entries) || !validResult(journal.result) || journal.result.requestId !== journal.requestId) {
      throw new TaskError('invalid_journal', 'The pending transaction journal is malformed.', 'Preserve pending.json and repair it before writing.');
    }
    const seen = new Set<string>();
    for (const entry of journal.entries) {
      if (!object(entry) || typeof entry.id !== 'string' || !(entry.before === null || typeof entry.before === 'string') || !(entry.after === null || typeof entry.after === 'string') || (entry.before === null && entry.after === null) || seen.has(entry.id)) {
        throw new TaskError('invalid_journal', 'Invalid transaction entry.', 'Preserve pending.json and repair it before writing.');
      }
      validateId(entry.id);
      seen.add(entry.id);
      if (parseTask(entry.after ?? entry.before!).task.id !== entry.id) throw new TaskError('invalid_journal', 'Transaction entry has a mismatched ID.', 'Repair the pending journal.');
    }
    const deleted = new Set(journal.entries.filter(entry => entry.after === null).map(entry => entry.id));
    // Validate local bindings before removing any file; recovery also finishes
    // this cleanup when a crash happened after the task file was removed.
    const bindings = deleted.size ? await this.readSessionBindings(await this.localInstanceId()) : undefined;
    // Preflight every entry before advancing any part of recovery.
    for (const entry of journal.entries) {
      const actual = await maybeText(this.taskPath(entry.id));
      if (actual !== entry.before && actual !== entry.after) conflict('An external edit conflicts with a pending transaction.', { taskId: entry.id, journal: pendingPath });
    }
    const current = await this.scan();
    const expectedFiles = new Map(current.fingerprints);
    for (const entry of journal.entries) {
      if (entry.after === null) expectedFiles.delete(`${entry.id}.md`);
      else expectedFiles.set(`${entry.id}.md`, hash(entry.after));
    }
    if (revisionOf(expectedFiles) !== journal.result.revision) conflict('Other task files changed while a transaction was pending.', { journal: pendingPath });
    for (const entry of journal.entries) {
      assertHeld();
      const actual = await maybeText(this.taskPath(entry.id));
      if (actual === entry.after) continue;
      if (actual !== entry.before) conflict('A file changed during transaction recovery.', { taskId: entry.id, journal: pendingPath });
      const path = this.taskPath(entry.id); // Validated ID, confined to the canonical tasks directory.
      if (entry.after === null) await unlink(path);
      else await atomicWrite(path, entry.after);
    }
    assertHeld();
    // Also flush deletions completed by a previous, interrupted recovery.
    if (deleted.size) await syncDirectory(join(this.canonicalRoot, 'tasks'));
    if ((await this.scan()).revision !== journal.result.revision) conflict('Task files changed during commit.', { journal: pendingPath });
    assertHeld();
    if (bindings?.some(binding => deleted.has(binding.taskId))) {
      await this.writeSessionBindings(bindings.filter(binding => !deleted.has(binding.taskId)));
      assertHeld();
    }
    await atomicWrite(this.receiptPath(journal.requestId), JSON.stringify({ digest: journal.digest, result: journal.result } satisfies Receipt));
    await unlink(pendingPath);
    await syncDirectory(this.local);
    this.notify();
  }

  async apply(plan: Plan): Promise<ApplyResult> {
    if (!object(plan) || typeof plan.requestId !== 'string' || !plan.requestId.trim() || plan.requestId.length > 200 || typeof plan.baseRevision !== 'string' || !Array.isArray(plan.operations) || plan.operations.length === 0 || plan.operations.length > 1000) {
      throw new TaskError('invalid_plan', 'Expected requestId, baseRevision and 1–1000 operations.', 'Read state, then provide a JSON batch plan.');
    }
    const encoded = JSON.stringify(plan);
    if (Buffer.byteLength(encoded) > MAX_PLAN) throw new TaskError('plan_too_large', 'Plan exceeds 16 MiB.', 'Split the operation into smaller plans.');
    const digest = hash(encoded);
    return this.locked(async assertHeld => {
      const saved = await maybeText(this.receiptPath(plan.requestId), MAX_JOURNAL);
      if (saved !== null) {
        const receipt = json<Receipt>(saved, 'operation receipt');
        if (!object(receipt) || typeof receipt.digest !== 'string' || !validResult(receipt.result) || receipt.result.requestId !== plan.requestId) {
          throw new TaskError('invalid_local_data', 'The operation receipt is malformed.', 'Preserve and repair the receipt before retrying.');
        }
        if (receipt.digest !== digest) throw new TaskError('request_reused', 'requestId was already used for a different plan.', 'Use a new requestId for a new operation.');
        return receipt.result;
      }
      const snapshot = await this.scan();
      if (snapshot.revision !== plan.baseRevision) conflict('The store changed after the plan was prepared.', { expected: plan.baseRevision, actual: snapshot.revision });
      const ids: Record<string, string> = Object.create(null);
      const created = new Map<number, string>();
      const allocated = new Set([...snapshot.fingerprints.keys()].map(name => name.slice(0, -3)));
      const contents = new Map(snapshot.contents);
      for (const [index, operation] of plan.operations.entries()) {
        if (!object(operation) || typeof operation.op !== 'string') throw new TaskError('invalid_plan', 'Every operation needs an op.', 'Use create, patch, replaceMarkdown, archive, restore or delete.');
        if (operation.op !== 'create') continue;
        let id = `task-${randomUUID()}`;
        while (allocated.has(id)) id = `task-${randomUUID()}`;
        allocated.add(id);
        created.set(index, id);
        if (operation.key !== undefined) {
          if (typeof operation.key !== 'string' || !operation.key || Object.hasOwn(ids, operation.key)) throw new TaskError('invalid_key', 'Temporary keys must be nonempty and unique.', 'Give each created task a unique key.');
          ids[operation.key] = id;
        }
      }
      const reference = (value: unknown): string => {
        if (typeof value === 'string') { validateId(value); return value; }
        if (object(value) && Object.keys(value).length === 1 && typeof value.key === 'string' && Object.hasOwn(ids, value.key)) return ids[value.key];
        throw new TaskError('invalid_reference', 'Unknown task reference.', 'Use a task ID or {"key":"a-created-task"}.', value);
      };
      const normalized = (value: Record<string, unknown>): Record<string, unknown> => {
        const result = { ...value };
        if (Object.hasOwn(result, 'parent')) result.parent = result.parent === null ? null : reference(result.parent);
        if (Object.hasOwn(result, 'blocked_by')) {
          if (!Array.isArray(result.blocked_by)) throw new TaskError('invalid_dependencies', 'blocked_by must be an array.', 'Provide task IDs or temporary references.');
          result.blocked_by = result.blocked_by.map(reference);
        }
        return result;
      };
      const requireContent = (id: string): string => {
        const content = contents.get(id);
        if (content === undefined) throw new TaskError('task_not_found', `Task not found: ${id}`, 'Check the task ID.');
        return content;
      };
      const checkVersion = (id: string, version: unknown, required = false) => {
        if (version === undefined && !required) return;
        if (typeof version !== 'string') throw new TaskError('version_required', 'expectedVersion is required for Markdown replacement.', 'Read the task before editing it.');
        const original = snapshot.contents.get(id);
        if (original === undefined || hash(original) !== version) conflict(`Task ${id} has changed.`, { taskId: id });
      };
      // Materialize all creates first so references can point forward in the plan.
      let lastOrder = [...snapshot.records.values()].map(record => record.task.order).sort().at(-1) ?? null;
      for (const [index, operation] of plan.operations.entries()) {
        if (operation.op !== 'create') continue;
        if (!object(operation.task) || typeof operation.task.title !== 'string') throw new TaskError('invalid_task', 'create requires task.title.', 'Supply the title and optional task fields.');
        for (const key of Object.keys(operation.task)) if (!patchKeys.has(key)) throw new TaskError('invalid_field', `Unsupported create field: ${key}`, 'IDs and schema are generated by taskmd.');
        const id = created.get(index)!;
        lastOrder = generateKeyBetween(lastOrder, null);
        const task = { schema: 1, id, title: operation.task.title, status: 'todo', parent: null, blocked_by: [], order: lastOrder, repo: null, assets: [], archived: false, body: '', ...normalized(operation.task as Record<string, unknown>) } as Task;
        contents.set(id, createDocument(task));
      }
      // Metadata changes precede archive expansion; subtrees use the final hierarchy.
      for (const operation of plan.operations) {
        if (operation.op === 'create' || operation.op === 'archive' || operation.op === 'restore' || operation.op === 'delete') continue;
        const id = reference(operation.id);
        const content = requireContent(id);
        if (operation.op === 'patch') {
          if (!object(operation.changes)) throw new TaskError('invalid_patch', 'changes must be an object.', 'Provide fields to change.');
          for (const key of Object.keys(operation.changes)) if (!patchKeys.has(key)) throw new TaskError('invalid_field', `Cannot patch field: ${key}`, 'Task IDs and schema cannot be changed.');
          checkVersion(id, operation.expectedVersion);
          contents.set(id, updateDocument(content, normalized(operation.changes) as Partial<Task>));
        } else if (operation.op === 'replaceMarkdown') {
          checkVersion(id, operation.expectedVersion, true);
          if (typeof operation.content !== 'string') throw new TaskError('invalid_content', 'content must be Markdown text.', 'Provide the complete Markdown document.');
          if (parseTask(operation.content).task.id !== id) throw new TaskError('id_mismatch', 'Editing cannot change a task ID.', 'Keep the original id in frontmatter.');
          contents.set(id, operation.content);
        } else throw new TaskError('invalid_operation', `Unknown operation: ${(operation as { op: string }).op}`, 'Use create, patch, replaceMarkdown, archive, restore or delete.');
      }
      const parsedTasks = new Map([...snapshot.records].map(([id, record]) => [id, { content: record.content, task: record.task }]));
      const allTasks = (): Task[] => [...contents].map(([id, content]) => {
        const cached = parsedTasks.get(id);
        const task = cached?.content === content ? cached.task : parseTask(content).task;
        if (task.id !== id) throw new TaskError('id_mismatch', `Task file ${id} contains ${task.id}`, 'Restore the original ID or repair the filename.');
        parsedTasks.set(id, { content, task });
        return task;
      });
      for (const operation of plan.operations) {
        if (operation.op !== 'archive' && operation.op !== 'restore') continue;
        const id = reference(operation.id);
        requireContent(id);
        const tasks = allTasks();
        const targets = new Set([id, ...descendants(tasks, id)]);
        if (operation.op === 'restore') {
          const byId = new Map(tasks.map(task => [task.id, task]));
          let parent = byId.get(id)?.parent;
          while (parent && !targets.has(parent)) { targets.add(parent); parent = byId.get(parent)?.parent; }
        }
        for (const target of targets) {
          const content = requireContent(target);
          const task = parseTask(content).task;
          if (operation.op === 'archive' && !terminal.has(task.status)) throw new TaskError('task_unfinished', `Cannot archive unfinished task: ${target}`, 'Finish or cancel the subtree first.');
          contents.set(target, updateDocument(content, { archived: operation.op === 'archive' }));
        }
      }
      const tasks = allTasks();
      const unresolved = snapshot.diagnostics.filter(issue => issue.severity === 'error' && (!issue.taskId || !snapshot.contents.has(issue.taskId)));
      const beforeTasks = [...snapshot.records.values()].map(record => record.task);
      const beforeErrors = new Set(analyze(beforeTasks).diagnostics
        .filter(issue => issue.severity === 'error').map(issueKey));
      const graph = analyze(tasks);
      // A store that already carries a defect (a hand-edited file, a legacy
      // cross-parent dependency) stays repairable: only defects the plan
      // *introduces* reject it.
      const errors = [...unresolved, ...graph.diagnostics
        .filter(issue => issue.severity === 'error' && !beforeErrors.has(issueKey(issue)))];
      if (errors.length) throw new TaskError('validation_failed', 'The final task graph is invalid.', 'Fix all reported errors and retry.', errors);
      const previous = new Map(beforeTasks.map(task => [task.id, task]));
      const byId = new Map(tasks.map(task => [task.id, task]));

      // Canceling a task cancels every unfinished descendant atomically. Completed
      // descendants keep their result, and dependencies never block a cancel.
      for (const task of tasks) {
        if (task.status !== 'canceled' || previous.get(task.id)?.status === 'canceled') continue;
        for (const id of descendants(tasks, task.id)) {
          const descendant = byId.get(id);
          if (!descendant || terminal.has(descendant.status)) continue;
          contents.set(id, updateDocument(contents.get(id)!, { status: 'canceled' }));
        }
      }
      if ([...contents].some(([id, content]) => content !== snapshot.contents.get(id))) {
        // Re-derive the tree after the cancel expansion before judging it.
        const refreshed = allTasks();
        byId.clear();
        for (const task of refreshed) byId.set(task.id, task);
      }

      // Starting a leaf advances its still-todo ancestors in the same transaction.
      // Completed, canceled or archived ancestors are never reopened implicitly.
      // A start is only `todo -> in_progress`: an explicit reopen from a terminal
      // state is a deliberate act, not a start, so it skips the leaf and ready
      // checks here (final-graph rules still judge the result below).
      const started = [...byId.values()].filter(task =>
        task.status === 'in_progress' && previous.get(task.id)?.status === 'todo');
      for (const task of started) {
        if (task.archived) throw new TaskError('not_ready', `Task ${task.title} (${task.id}) is archived.`, 'Restore the task before starting it.');
        if ([...byId.values()].some(child => child.parent === task.id)) {
          throw new TaskError('not_ready', `Task ${task.title} (${task.id}) has child tasks and is not a leaf.`, 'Start a leaf task; its parents advance automatically.');
        }
        const blockers = executionBlockers([...byId.values()], task.id);
        if (blockers.length) {
          throw new TaskError('not_ready', `Task ${task.title} (${task.id}) is not ready to start.`,
            'Finish its direct dependencies and reopen any completed or canceled ancestor.',
            blockers.map(blocker => ({ code: 'not_ready', message: blocker.message, severity: 'error', taskId: blocker.taskId, dependencyId: blocker.dependencyId })));
        }
        const seen = new Set([task.id]);
        let parent = task.parent;
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          const ancestor = byId.get(parent);
          if (!ancestor) break;
          if (ancestor.status === 'todo' && !ancestor.archived) {
            contents.set(ancestor.id, updateDocument(contents.get(ancestor.id)!, { status: 'in_progress' }));
            byId.set(ancestor.id, { ...ancestor, status: 'in_progress' });
          }
          parent = ancestor.parent;
        }
      }
      const finalTasks = allTasks();
      const finalById = new Map(finalTasks.map(task => [task.id, task]));

      for (const task of finalTasks) {
        const old = previous.get(task.id);
        if (task.archived && !terminal.has(task.status)) throw new TaskError('task_unfinished', `Archived task ${task.id} is unfinished.`, 'Restore the task before reopening it.');
        if (!task.archived && task.parent && finalById.get(task.parent)?.archived) throw new TaskError('archived_parent', `Task ${task.id} has an archived parent.`, 'Restore its ancestors first.');
        if (task.status === old?.status) continue;
        // `todo -> in_progress` was judged as a start above. A terminal ->
        // in_progress transition is an explicit reopen: deliberate, and the
        // final-graph rules below still reject a reopen that leaves the task
        // waiting (ruleViolations) or archived (task_unfinished above).
        if (task.status === 'done') {
          const unfinished = finalTasks.filter(child => child.parent === task.id && !terminal.has(child.status));
          if (unfinished.length) {
            throw new TaskError('not_complete', `Task ${task.title} (${task.id}) has unfinished child tasks.`,
              'Finish or cancel every child task first; a parent is never completed automatically.',
              unfinished.map(child => ({ code: 'not_complete', message: `Unfinished child ${child.title} (${child.id}).`, severity: 'error', taskId: task.id })));
          }
          const blockers = executionBlockers(finalTasks, task.id);
          if (blockers.length) {
            throw new TaskError('not_complete', `Task ${task.title} (${task.id}) has unfinished prerequisites.`,
              'Finish its direct dependencies and those of its ancestors first.',
              blockers.map(blocker => ({ code: 'not_complete', message: blocker.message, severity: 'error', taskId: blocker.taskId, dependencyId: blocker.dependencyId })));
          }
        }
      }

      // Structural edits (moving a task, changing dependencies, reopening a
      // dependency target) may not leave executing or completed tasks waiting.
      // Pre-existing inconsistencies stay as diagnostics, not new rejections.
      const existing = ruleViolations(beforeTasks);
      const regressions: Diagnostic[] = [];
      for (const [taskId, entries] of ruleViolations(finalTasks)) {
        for (const [key, issue] of entries) if (!existing.get(taskId)?.has(key)) regressions.push(issue);
      }
      if (regressions.length) {
        throw new TaskError('not_ready', 'The plan would leave tasks in an invalid execution state.',
          'Reopen the reported tasks or adjust their dependencies in the same plan.', regressions);
      }

      // Deletes are explicit and run after metadata/status changes. Deleting a
      // tree requires individual operations ordered from children to parents.
      for (const operation of plan.operations) {
        if (operation.op !== 'delete') continue;
        const id = reference(operation.id);
        const task = parseTask(requireContent(id)).task;
        checkVersion(id, operation.expectedVersion);
        const blockers = deletionBlockers(allTasks(), task);
        if (blockers.length) throw new TaskError('delete_blocked', `无法删除任务「${task.title}」。`,
          blockers.map(issue => issue.message).join(' '), blockers);
        contents.delete(id);
      }
      const deleted = [...snapshot.contents.keys()].filter(id => !contents.has(id));
      if (deleted.length) await this.readSessionBindings(await this.localInstanceId());
      const entries: Entry[] = [];
      const fingerprints = new Map(snapshot.fingerprints);
      const versions: Record<string, string> = Object.create(null);
      for (const [id, after] of contents) {
        const before = snapshot.contents.get(id) ?? null;
        if (before === after) continue;
        entries.push({ id, before, after });
        versions[id] = hash(after);
        fingerprints.set(`${id}.md`, versions[id]);
      }
      for (const id of deleted) {
        entries.push({ id, before: snapshot.contents.get(id)!, after: null });
        fingerprints.delete(`${id}.md`);
      }
      const result: ApplyResult = { schemaVersion: 1, requestId: plan.requestId, revision: revisionOf(fingerprints), ids, versions };
      // Recheck the entire read set just before preparing the durable transaction.
      if ((await this.scan()).revision !== snapshot.revision) conflict('External files changed during validation.');
      assertHeld();
      const journal: Journal = { schema: 1, requestId: plan.requestId, digest, entries, result };
      const journalContent = JSON.stringify(journal);
      if (Buffer.byteLength(journalContent) > MAX_JOURNAL) throw new TaskError('plan_too_large', 'Transaction journal exceeds 64 MiB.', 'Use smaller batches.');
      await atomicWrite(join(this.local, 'pending.json'), journalContent);
      await this.recover(assertHeld);
      return result;
    });
  }

  private async repositories(): Promise<Record<string, string>> {
    const source = await maybeText(join(this.local, 'repositories.json'));
    const parsed = source === null ? {} : json<unknown>(source, 'repositories.json');
    if (!object(parsed) || Object.values(parsed).some(value => typeof value !== 'string' || !isAbsolute(value))) throw new TaskError('invalid_local_data', 'Invalid repository registry.', 'Repair repositories.json.');
    return Object.assign(Object.create(null), parsed) as Record<string, string>;
  }

  async reposList(): Promise<Record<string, string>> { return this.locked(() => this.repositories()); }

  async reposSet(name: string, path: string): Promise<Record<string, string>> {
    validateId(name);
    return this.locked(async assertHeld => {
      const root = await realpath(resolve(path));
      if (!(await lstat(root)).isDirectory()) throw new TaskError('invalid_repository', 'Repository path must be a directory.', 'Choose an existing directory.');
      const repos = await this.repositories();
      repos[name] = root;
      assertHeld();
      await atomicWrite(join(this.local, 'repositories.json'), JSON.stringify(repos, null, 2));
      this.notify();
      return repos;
    });
  }

  async reposRemove(name: string): Promise<Record<string, string>> {
    validateId(name);
    return this.locked(async assertHeld => {
      const repos = await this.repositories();
      if (!Object.hasOwn(repos, name)) throw new TaskError('repository_not_found', `Unknown repository: ${name}`, 'Use repos list.');
      delete repos[name];
      assertHeld();
      await atomicWrite(join(this.local, 'repositories.json'), JSON.stringify(repos, null, 2));
      this.notify();
      return repos;
    });
  }

  /** Reads or generates the stable per-machine identity used for bindings. */
  private async localInstanceId(): Promise<string> {
    if (this.instanceId !== undefined) return this.instanceId;
    const existing = await this.readInstanceId();
    if (existing !== null) { this.instanceId = existing; return existing; }
    const generated = randomUUID();
    // Two processes can race on the very first run; O_EXCL makes exactly one win
    // and the loser adopts the winner's identity instead of forking the machine.
    const path = this.instancePath();
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ instanceId: generated }, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(dirname(path));
      this.instanceId = generated;
      return generated;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    } finally { await handle?.close(); }
    const adopted = await this.readInstanceId();
    if (adopted === null) throw new TaskError('invalid_local_data', 'Instance identity vanished while it was being created.', 'Retry the command; delete instance.json if this persists.');
    this.instanceId = adopted;
    return adopted;
  }

  private instancePath(): string { return join(this.local, 'instance.json'); }

  private async readInstanceId(): Promise<string | null> {
    const source = await maybeText(this.instancePath());
    if (source === null) return null;
    const parsed = json<unknown>(source, 'instance.json');
    if (!object(parsed) || typeof parsed.instanceId !== 'string'
      || !parsed.instanceId.trim() || parsed.instanceId.length > 200) {
      throw new TaskError('invalid_local_data', 'Invalid instance identity.', 'Repair or delete instance.json; a new identity is generated on the next binding.');
    }
    return parsed.instanceId;
  }

  /**
   * Reads bindings, filling in the local identity for pre-`instanceId` rows and
   * collapsing repeated identities onto the oldest row. Nothing is written here:
   * migration happens with the next binding write, so reads stay read-only.
   */
  private async readSessionBindings(instanceId: string): Promise<TaskSessionBinding[]> {
    const source = await maybeText(join(this.local, 'sessions.json'));
    const raw = source === null ? [] : json<unknown>(source, 'sessions.json');
    const invalid = () => new TaskError('invalid_local_data', 'Invalid session bindings.', 'Repair sessions.json.');
    if (!Array.isArray(raw)) throw invalid();
    const bindings: TaskSessionBinding[] = [];
    const identities = new Set<string>();
    for (const entry of raw) {
      if (!object(entry)) throw invalid();
      const provider = entry.provider === undefined ? LEGACY_PROVIDER : entry.provider;
      if (typeof provider !== 'string' || !provider.trim() || provider.length > 100) throw invalid();
      const recordInstance = entry.instanceId === undefined ? instanceId : entry.instanceId;
      if (typeof recordInstance !== 'string' || !recordInstance.trim() || recordInstance.length > 200) throw invalid();
      if (typeof entry.taskId !== 'string' || !entry.taskId) throw invalid();
      if (typeof entry.sessionId !== 'string' || !entry.sessionId.trim() || entry.sessionId.length > MAX_SESSION_ID) throw invalid();
      if (typeof entry.createdAt !== 'string') throw invalid();
      if (entry.lastOpenedAt !== undefined && typeof entry.lastOpenedAt !== 'string') throw invalid();
      const identity = `${provider}\u0000${recordInstance}\u0000${entry.sessionId}`;
      // Legacy data could bind one Session to several tasks. Rows were appended
      // in creation order, so the first one keeps the identity and the duplicate
      // still surfaces as `session_already_bound` on the next bind attempt.
      if (identities.has(identity)) continue;
      identities.add(identity);
      bindings.push({
        taskId: entry.taskId, provider, instanceId: recordInstance, sessionId: entry.sessionId, createdAt: entry.createdAt,
        ...(entry.lastOpenedAt === undefined ? {} : { lastOpenedAt: entry.lastOpenedAt }),
      });
    }
    return bindings;
  }

  private async writeSessionBindings(bindings: TaskSessionBinding[]): Promise<void> {
    await atomicWrite(join(this.local, 'sessions.json'), JSON.stringify(bindings, null, 2));
  }

  /** Resolves the instance a write targets; the local machine unless named. */
  private async bindingInstanceId(explicit: string | undefined): Promise<string> {
    if (explicit === undefined) return this.localInstanceId();
    if (typeof explicit !== 'string' || !explicit.trim() || explicit.length > 200) {
      throw new TaskError('invalid_instance', 'Invalid instance ID.', 'Omit the instance ID to use this machine.');
    }
    return explicit;
  }

  async listSessionBindings(filter: TaskSessionBindingFilter = {}): Promise<TaskSessionBinding[]> {
    if (filter.taskId !== undefined) validateId(filter.taskId);
    return this.locked(async () => {
      const bindings = await this.readSessionBindings(await this.localInstanceId());
      return bindings.filter(binding =>
        (filter.taskId === undefined || binding.taskId === filter.taskId)
        && (filter.provider === undefined || binding.provider === filter.provider)
        && (filter.instanceId === undefined || binding.instanceId === filter.instanceId)
        && (filter.sessionId === undefined || binding.sessionId === filter.sessionId));
    });
  }

  /**
   * Links a Task to a Session. A Session identity may reference at most one Task;
   * rebinding it elsewhere raises `session_already_bound` instead of silently
   * moving it, so a client can ask the user to confirm. Repeated binds of the
   * same pair are idempotent. Task files, status, dependencies and the tree are
   * never touched here.
   */
  async bindSession(taskId: string, sessionId: string, options: SessionWriteOptions = {}): Promise<void> {
    const provider = sessionProvider(options.provider);
    checkSessionId(sessionId);
    await this.locked(async assertHeld => {
      const content = await maybeText(this.taskPath(taskId));
      if (content === null) throw new TaskError('task_not_found', `Unknown task: ${taskId}`, 'Use list to find a task.');
      const instanceId = await this.bindingInstanceId(options.instanceId);
      const bindings = await this.readSessionBindings(instanceId);
      const existing = bindings.find(binding => binding.provider === provider
        && binding.instanceId === instanceId && binding.sessionId === sessionId);
      if (existing?.taskId === taskId) {
        // A repeated bind is a client re-attaching an already linked Session, so
        // it refreshes the touch time without duplicating the row or moving
        // `createdAt`. Opening a Session goes through `touchSessionBinding`.
        const at = new Date().toISOString();
        const touched = bindings.map(binding => binding === existing ? { ...binding, lastOpenedAt: at } : binding);
        assertHeld();
        await this.writeSessionBindings(touched);
        this.notify();
        return;
      }
      if (existing) {
        throw new TaskError('session_already_bound',
          `Session ${sessionId} is already bound to task ${existing.taskId}.`,
          'Unbind it from the other task first, then bind it here.',
          { taskId, existingTaskId: existing.taskId, provider, instanceId, sessionId });
      }
      bindings.push({ taskId, provider, instanceId, sessionId, createdAt: new Date().toISOString() });
      assertHeld();
      await this.writeSessionBindings(bindings);
      this.notify();
    });
  }

  /**
   * Records that a client opened one bound Session, for recency ordering.
   *
   * Distinct from {@link bindSession} on purpose. Opening is keyed by the
   * Session identity the caller holds, never by a Task, so it must not read the
   * Task file first: a Task archived or moved after binding still has to open
   * its Session. It also never creates a row — opening an unbound Session is
   * not a binding request — and an absent row is a no-op reported as `false`.
   * Task files, status, dependencies and the tree are never touched here.
   */
  async touchSessionBinding(sessionId: string, options: SessionWriteOptions = {}): Promise<boolean> {
    checkSessionId(sessionId);
    const provider = sessionProvider(options.provider);
    return this.locked(async assertHeld => {
      const instanceId = await this.bindingInstanceId(options.instanceId);
      const bindings = await this.readSessionBindings(instanceId);
      const existing = bindings.find(binding => binding.provider === provider
        && binding.instanceId === instanceId && binding.sessionId === sessionId);
      if (existing === undefined) return false;
      const at = new Date().toISOString();
      if (existing.lastOpenedAt === at) return false;
      const touched = bindings.map(binding => binding === existing ? { ...binding, lastOpenedAt: at } : binding);
      assertHeld();
      await this.writeSessionBindings(touched);
      this.notify();
      return true;
    });
  }

  /**
   * Removes one binding. Without `provider`/`instanceId` this targets only this
   * machine's records, which also matches migrated legacy rows.
   */
  async unbindSession(taskId: string, sessionId: string, options: SessionWriteOptions = {}): Promise<void> {
    validateId(taskId);
    checkSessionId(sessionId);
    const provider = sessionProvider(options.provider);
    await this.locked(async assertHeld => {
      const instanceId = await this.bindingInstanceId(options.instanceId);
      const bindings = await this.readSessionBindings(instanceId);
      const remaining = bindings.filter(binding => !(binding.provider === provider
        && binding.instanceId === instanceId && binding.sessionId === sessionId && binding.taskId === taskId));
      if (remaining.length === bindings.length) return;
      assertHeld();
      await this.writeSessionBindings(remaining);
      this.notify();
    });
  }

  async repositoryDirectory(taskId: string): Promise<string | null> {
    return this.locked(async () => {
      const content = await maybeText(this.taskPath(taskId));
      if (content === null) throw new TaskError('task_not_found', `Unknown task: ${taskId}`, 'Use list to find a task.');
      const { task } = parseTask(content);
      if (task.id !== taskId) throw new TaskError('id_mismatch', `Task file ${taskId} contains ${task.id}`, 'Repair the task ID or filename.');
      if (task.repo === null) return null;
      const directory = (await this.repositories())[task.repo];
      if (!directory) throw new TaskError('repository_not_found', `Repository is not mapped: ${task.repo}`, 'Register it with repos set.');
      const root = await realpath(directory);
      if (!(await lstat(root)).isDirectory()) throw new TaskError('invalid_repository', 'Repository path must be a directory.', 'Choose an existing directory.');
      return root;
    });
  }

  async readAsset(taskId: string, index: number): Promise<{ content: string; path: string; version: string }> {
    return this.locked(async () => {
      if (!Number.isSafeInteger(index) || index < 0) throw new TaskError('invalid_asset', 'Asset index must be a nonnegative integer.', 'Use the asset index in task details.');
      const content = await maybeText(this.taskPath(taskId));
      if (content === null) throw new TaskError('task_not_found', `Unknown task: ${taskId}`, 'Use list to find a task.');
      const asset = parseTask(content).task.assets[index];
      if (!asset) throw new TaskError('asset_not_found', 'Asset index does not exist.', 'Use show to inspect task assets.');
      const repos = await this.repositories();
      const configured = asset.kind === 'shared' ? join(this.canonicalRoot, 'assets') : repos[asset.repo!];
      if (!configured) throw new TaskError('repository_not_found', `Repository is not mapped: ${asset.repo}`, 'Register it with repos set.');
      const root = await realpath(configured);
      const target = await realpath(resolve(root, asset.path));
      const within = relative(root, target);
      if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new TaskError('asset_escape', 'Asset path escapes its root.', 'Reference a file inside its registered root.');
      const text = await readText(target);
      return { content: text, path: asset.path, version: hash(text) };
    });
  }

  private notify(): void {
    clearTimeout(this.debounce);
    if (!this.listeners.size) return;
    this.debounce = setTimeout(() => {
      for (const listener of this.listeners) { try { listener(); } catch { /* One subscriber must not break storage. */ } }
    }, 75);
    this.debounce.unref();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (!this.watching) {
      const generation = ++this.watchGeneration;
      this.watching = withConfigurationLock(async () => {
        this.assertConfiguration();
        await this.prepare();
      }).then(() => {
        if (generation !== this.watchGeneration || !this.listeners.size) return;
        const failed = () => {
          if (generation !== this.watchGeneration) return;
          for (const watcher of this.watchers) watcher.close();
          this.watchers.clear();
          if (generation === this.watchGeneration) this.watching = undefined;
          this.notify();
        };
        try {
          const tasks = watch(join(this.canonicalRoot, 'tasks'), () => this.notify());
          this.watchers.add(tasks);
          tasks.on('error', failed);
          const local = watch(this.local, (_event, filename) => {
            // Reads take writer.lock and may recover pending.json; neither may
            // trigger a refetch loop. Atomic writes finish with these filenames.
            const name = filename?.toString();
            if (name === 'sessions.json' || name === 'repositories.json') this.notify();
          });
          this.watchers.add(local);
          local.on('error', failed);
        } catch (error) {
          failed();
          throw error;
        }
        this.notify();
      }).catch(() => {
        if (generation === this.watchGeneration) this.watching = undefined;
        this.notify();
      });
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.close();
    };
  }

  close(): void {
    this.watchGeneration++;
    for (const watcher of this.watchers) watcher.close();
    this.watchers.clear();
    this.listeners.clear();
    clearTimeout(this.debounce);
    this.watching = undefined;
  }
}
