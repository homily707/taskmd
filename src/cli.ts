import { Command, CommanderError, Option, InvalidArgumentError } from 'commander';
import { createReadStream } from 'node:fs';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { Store } from './core/store.js';
import { descendants } from './core/graph.js';
import { TaskError, type Task, type TaskMetadata, type TaskStatus, type State, type Operation, type ApplyResult } from './types.js';
import { absolutePath, configure, configKey, resolveConfiguration, type Configuration } from './core/config.js';
import { startServer, errorEnvelope, parsePlan, readUtf8, INPUT_LIMIT, PLAN_INPUT_LIMIT } from './server.js';

const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'done', 'canceled'];
const byteCompare = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const compareTasks = (left: TaskMetadata, right: TaskMetadata) => byteCompare(left.order, right.order) || byteCompare(left.id, right.id);

function statusValue(value: string): TaskStatus {
  if (!STATUSES.includes(value as TaskStatus)) {
    throw new InvalidArgumentError(`Status must be one of: ${STATUSES.join(', ')}.`);
  }
  return value as TaskStatus;
}

function integer(value: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))
    || Number(value) < minimum || Number(value) > maximum) {
    throw new InvalidArgumentError(`Expected an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function taskIn<T extends TaskMetadata>(state: { tasks: T[] }, id: string): T {
  const task = state.tasks.find((entry) => entry.id === id);
  if (!task) throw new TaskError('TASK_NOT_FOUND', `Task ${id} was not found.`);
  return task;
}

function rows(tasks: TaskMetadata[]): string {
  return tasks.map((task) => `${task.id}\t${task.status}\t${task.title}${task.archived ? ' [archived]' : ''}`).join('\n');
}

function treeRows<T extends TaskMetadata>(tasks: T[], root?: string): { task: T; depth: number }[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const children = new Map<string | null, T[]>();
  for (const task of tasks) {
    const parent = task.parent && byId.has(task.parent) ? task.parent : null;
    const list = children.get(parent) || [];
    list.push(task);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort(compareTasks);
  const result: { task: T; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (seeds: T[], depth: number) => {
    const stack = [...seeds].reverse().map((task) => ({ task, depth }));
    while (stack.length) {
      const current = stack.pop()!;
      if (seen.has(current.task.id)) continue;
      seen.add(current.task.id);
      result.push(current);
      for (const child of [...(children.get(current.task.id) || [])].reverse()) {
        stack.push({ task: child, depth: current.depth + 1 });
      }
    }
  };
  if (root) visit(byId.has(root) ? [byId.get(root)!] : [], 0);
  else {
    visit(children.get(null) || [], 0);
    // Keep malformed/cyclic components visible so check can explain them.
    visit([...tasks].sort(compareTasks).filter((task) => !seen.has(task.id)), 0);
  }
  return result;
}

async function inputFile(path: string, limit = INPUT_LIMIT): Promise<string> {
  if (path === '-') return readUtf8(process.stdin, limit);
  return readUtf8(createReadStream(resolve(path)), limit);
}

async function assertExpected(store: Store, id: string, expectedVersion?: string): Promise<void> {
  if (expectedVersion === undefined) return;
  const actualVersion = (await store.read(id)).version;
  if (actualVersion !== expectedVersion) {
    throw new TaskError('VERSION_CONFLICT', `Task ${id} has changed.`, 'Read the task again and merge before retrying.',
      { taskId: id, expected: expectedVersion, actual: actualVersion });
  }
}

async function versionPatch(store: Store, task: Task, changes: Partial<Task>): Promise<Operation> {
  return { op: 'patch', id: task.id, changes, expectedVersion: (await store.read(task.id)).version };
}

async function position(
  store: Store, state: State, parent: string | null,
  options: { moving?: Task; before?: string; after?: string },
): Promise<{ order: string; operations: Operation[] }> {
  if (parent) {
    const destination = taskIn(state, parent);
    if (destination.archived) throw new TaskError('ARCHIVED_PARENT', 'Cannot move or create under an archived task.');
  }
  if (options.before && options.after) throw new TaskError('INVALID_ARGUMENT', 'Use only one of --before and --after.');
  const siblings = state.tasks.filter((task) => task.parent === parent && !task.archived && task.id !== options.moving?.id).sort(compareTasks);
  let index = siblings.length;
  const anchor = options.before || options.after;
  if (anchor) {
    const found = siblings.findIndex((task) => task.id === anchor);
    if (found < 0) throw new TaskError('INVALID_POSITION', `Task ${anchor} is not an active sibling at the destination.`);
    index = found + (options.after ? 1 : 0);
  }
  const equalKeys = siblings.some((task, i) => i > 0 && task.order === siblings[i - 1]!.order);
  if (!equalKeys) {
    try {
      const order = generateKeyBetween(siblings[index - 1]?.order ?? null, siblings[index]?.order ?? null);
      if (order.length <= 128) return { order, operations: [] };
    } catch {
      // Legacy/invalid fractional keys are repaired together under the same revision.
    }
  }
  const keys = generateNKeysBetween(null, null, siblings.length + 1);
  const operations: Operation[] = [];
  for (let i = 0; i < siblings.length; i++) {
    const task = siblings[i]!;
    const order = keys[i < index ? i : i + 1]!;
    if (order !== task.order) operations.push(await versionPatch(store, task, { order }));
  }
  return { order: keys[index]!, operations };
}

function editorCommand(editor: string, file: string): { command: string; env: NodeJS.ProcessEnv } {
  if (process.platform === 'win32') {
    // cmd expands this variable once; the random temp name never enters command syntax.
    return { command: `${editor} "%TASKMD_EDIT_FILE%"`, env: { ...process.env, TASKMD_EDIT_FILE: file } };
  }
  const quoted = `'${file.replace(/'/g, `'"'"'`)}'`;
  return { command: `${editor} ${quoted}`, env: process.env };
}

async function editInteractive(store: Store, state: State, id: string, expectedVersion?: string): Promise<ApplyResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new TaskError('EDITOR_REQUIRES_TTY', 'Interactive editing requires a terminal.', 'Use edit <id> -f FILE --if-version VERSION.');
  }
  const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (!editor) throw new TaskError('EDITOR_NOT_SET', 'Set VISUAL or EDITOR, or supply -f FILE and --if-version.');
  const record = await store.read(id);
  if (expectedVersion !== undefined && record.version !== expectedVersion) {
    throw new TaskError('VERSION_CONFLICT', 'The task version has changed.', 'Read the task again before editing.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'taskmd-edit-'));
  const file = join(directory, 'draft.md');
  try {
    await writeFile(file, record.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const invocation = editorCommand(editor, file);
    await new Promise<void>((resolveEditor, reject) => {
      const child = spawn(invocation.command, { shell: true, stdio: ['inherit', process.stderr, process.stderr], env: invocation.env });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolveEditor();
        else reject(new TaskError('EDITOR_FAILED', `Editor exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
      });
    });
    const content = await inputFile(file);
    const result = await store.apply({
      requestId: randomUUID(), baseRevision: state.revision,
      operations: [{ op: 'replaceMarkdown', id, content, expectedVersion: record.version }],
    });
    // Only remove the exact private draft paths created by this invocation.
    await unlink(file).catch(() => {});
    await rmdir(directory).catch(() => {});
    return result;
  } catch (error) {
    const failure = errorEnvelope(error);
    throw new TaskError(failure.code, failure.message,
      `Draft retained at ${file}. Read the latest task and retry with -f FILE --if-version VERSION.`,
      { draft: file, cause: failure });
  }
}

function contextFor(state: State, id: string, depth: number, maxBytes: number): Record<string, unknown> {
  const root = taskIn(state, id);
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const childIds = new Map<string, string[]>();
  for (const task of [...state.tasks].sort(compareTasks)) {
    if (task.parent) childIds.set(task.parent, [...(childIds.get(task.parent) || []), task.id]);
  }
  const selected: Task[] = [];
  const seen = new Set<string>();
  const queue: { id: string; depth: number }[] = [{ id: root.id, depth: 0 }];
  let omitted = 0;
  const base = { schemaVersion: 1, revision: state.revision, taskId: id, depth, maxBytes, assetsIncluded: false };
  // Reserve room for the final truncation metadata and JSON framing.
  let used = Buffer.byteLength(JSON.stringify(base)) + 256;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const entry = queue[cursor]!;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const task = byId.get(entry.id);
    if (!task) continue;
    const cost = Buffer.byteLength(JSON.stringify(task)) + 1;
    if (used + cost > maxBytes) {
      omitted++;
      if (task.id === id) {
        // Preserve a bounded prefix while retaining explicit references to omitted content.
        const clipped: Task = { ...task, body: '' };
        const overhead = Buffer.byteLength(JSON.stringify(clipped)) + 1;
        if (used + overhead <= maxBytes) {
          let low = 0;
          let high = task.body.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (used + Buffer.byteLength(JSON.stringify({ ...clipped, body: task.body.slice(0, middle) })) + 1 <= maxBytes) low = middle;
            else high = middle - 1;
          }
          clipped.body = task.body.slice(0, low);
          selected.push(clipped);
          used += Buffer.byteLength(JSON.stringify(clipped)) + 1;
        }
      }
    } else { selected.push(task); used += cost; }
    if (entry.depth < depth) {
      const references = [task.parent, ...task.blocked_by, ...(childIds.get(task.id) || [])].filter((value): value is string => Boolean(value));
      for (const reference of references) if (!seen.has(reference)) queue.push({ id: reference, depth: entry.depth + 1 });
    }
  }
  return { ...base, tasks: selected, truncated: omitted > 0, omittedTasksOrBodies: omitted };
}

export async function main(argv = process.argv): Promise<void> {
  const program = new Command();
  let store: Store | undefined;
  const jsonRequested = argv.slice(2).includes('--json');
  const json = () => Boolean(program.opts<{ json?: boolean }>().json || jsonRequested);
  const emit = (value: unknown, human?: string) => {
    if (json()) process.stdout.write(`${JSON.stringify(value)}\n`);
    else process.stdout.write(`${human ?? JSON.stringify(value, null, 2)}\n`);
  };
  const getStore = () => {
    store ??= new Store({ root: program.opts<{ store?: string }>().store });
    return store;
  };
  const apply = async (state: State, operations: Operation[]) => {
    const result = await getStore().apply({ requestId: randomUUID(), baseRevision: state.revision, operations });
    emit(result);
    return result;
  };
  const command = (parent: Command, name: string, description: string) => parent.command(name)
    .description(description).allowExcessArguments(false).allowUnknownOption(false);
  program.name('taskmd').description('Markdown tasks with versioned graph operations')
    .option('--store <directory>', 'task store directory')
    .option('--json', 'print JSON on stdout and structured errors on stderr')
    .allowExcessArguments(false).allowUnknownOption(false).showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => emit({ schemaVersion: 1, help: text }, text.trimEnd()),
      writeErr: () => {},
      outputError: () => {},
    });

  const emitConfiguration = (configuration: Configuration) => emit({ schemaVersion: 1, ...configuration },
    `Configuration: ${configuration.file}\n${(['store', 'root'] as const).map(key => `${key}\t${configuration.values[key]}\t(${configuration.sources[key]})`).join('\n')}`);
  const config = command(program, 'config', 'manage persistent local settings: store and root');
  const storeOverride = () => program.opts<{ store?: string }>().store;
  command(config, 'list', 'show effective paths and their sources').action(() => {
    emitConfiguration(resolveConfiguration(storeOverride()));
  });
  command(config, 'get <key>', 'read the effective store or root path').action((key: string) => {
    const selected = configKey(key);
    const configuration = resolveConfiguration(storeOverride());
    emit({ schemaVersion: 1, key: selected, value: configuration.values[selected], source: configuration.sources[selected], file: configuration.file }, configuration.values[selected]);
  });
  command(config, 'set <key> <path>', 'save a store or root path; existing data is not moved')
    .action(async (key: string, path: string) => emitConfiguration(await configure(configKey(key), path, storeOverride())));
  command(config, 'unset <key>', 'remove a saved setting and use its fallback')
    .action(async (key: string) => emitConfiguration(await configure(configKey(key), undefined, storeOverride())));

  command(program, 'init [directory]', 'initialize a store').action(async (directory?: string) => {
    const root = program.opts<{ store?: string }>().store;
    if (directory && root && absolutePath(directory) !== absolutePath(root)) {
      throw new TaskError('INVALID_ARGUMENT', 'init directory and --store must name the same directory.');
    }
    store = new Store({ root: directory || root });
    emit({ schemaVersion: 1, ...await store.init() });
  });

  const repos = command(program, 'repos', 'manage local repository mappings');
  command(repos, 'list', 'list mappings').action(async () => emit({ schemaVersion: 1, repos: await getStore().reposList() }));
  command(repos, 'set <name> <path>', 'set a local repository mapping').action(async (name: string, path: string) => {
    emit({ schemaVersion: 1, repos: await getStore().reposSet(name, resolve(path)) });
  });
  command(repos, 'remove <name>', 'remove a repository mapping').action(async (name: string) => {
    emit({ schemaVersion: 1, repos: await getStore().reposRemove(name) });
  });

  command(program, 'list', 'list active tasks; --archived includes archived tasks')
    .option('--status <status>', 'filter by task status', statusValue)
    .option('--repo <name>', 'filter by repository')
    .option('--parent <id>', 'filter direct children')
    .option('--archived', 'include archived tasks')
    .action(async (options: { status?: TaskStatus; repo?: string; parent?: string; archived?: boolean }) => {
      const state = json() ? await getStore().state() : await getStore().metadataState();
      const tasks = state.tasks.filter((task) => (options.archived || !task.archived)
        && (!options.status || task.status === options.status)
        && (options.repo === undefined || task.repo === options.repo)
        && (options.parent === undefined || task.parent === options.parent)).sort(compareTasks);
      emit({ schemaVersion: 1, revision: state.revision, tasks }, rows(tasks));
    });

  command(program, 'tree [id]', 'show the task hierarchy, including archived tasks').action(async (id?: string) => {
    const state = json() ? await getStore().state() : await getStore().metadataState();
    if (id) taskIn(state, id);
    const tree = treeRows(state.tasks, id);
    emit({ schemaVersion: 1, revision: state.revision, tree }, tree.map(({ task, depth }) => `${'  '.repeat(Math.min(depth, 100))}${rows([task])}`).join('\n'));
  });

  command(program, 'show <id>', 'read a task and its version').option('--raw', 'print original Markdown (JSON wraps content)')
    .action(async (id: string, options: { raw?: boolean }) => {
      if (options.raw && !json()) {
        process.stdout.write((await getStore().read(id)).content);
        return;
      }
      const state = await getStore().state();
      const record = await getStore().read(id);
      emit({ schemaVersion: 1, revision: state.revision, ...record });
    });

  command(program, 'ready', 'list tasks ready to start').action(async () => {
    const state = json() ? await getStore().state() : await getStore().metadataState();
    const ready = new Set(state.ready);
    const tasks = state.tasks.filter((task) => ready.has(task.id)).sort(compareTasks);
    emit({ schemaVersion: 1, revision: state.revision, ready: state.ready, tasks }, rows(tasks));
  });

  command(program, 'context <id>', 'bounded task context with references; never reads asset contents')
    .option('--depth <number>', 'maximum reference traversal depth (0–8)', (value) => integer(value, 0, 8), 2)
    .option('--max-bytes <number>', 'maximum compact JSON context size (1024–1048576)', (value) => integer(value, 1024, 1_048_576), 65_536)
    .action(async (id: string, options: { depth: number; maxBytes: number }) => {
      const result = contextFor(await getStore().state(), id, options.depth, options.maxBytes);
      // Compact JSON keeps the same byte bound in both output modes.
      process.stdout.write(`${JSON.stringify(result)}\n`);
    });

  command(program, 'check [id]', 'validate the whole graph and optionally require a task ID').action(async (id?: string) => {
    const state = await getStore().state();
    const diagnostics = state.diagnostics;
    if (id && !state.tasks.some((task) => task.id === id) && !diagnostics.some((entry) => entry.taskId === id)) taskIn(state, id);
    const ok = !diagnostics.some((entry) => entry.severity === 'error');
    emit({ schemaVersion: 1, revision: state.revision, ...(id ? { taskId: id } : {}), ok, diagnostics },
      diagnostics.length ? diagnostics.map((entry) => `${entry.severity}\t${entry.code}\t${entry.taskId || '-'}\t${entry.message}`).join('\n') : 'OK');
    if (!ok) process.exitCode = 1;
  });

  command(program, 'create <title>', 'create a task').option('--parent <id>', 'parent task').option('--repo <name>', 'repository name')
    .action(async (title: string, options: { parent?: string; repo?: string }) => {
      if (!title.trim()) throw new TaskError('INVALID_TITLE', 'Task title must not be empty.');
      const state = await getStore().state();
      const parent = options.parent ?? null;
      const placement = await position(getStore(), state, parent, {});
      await apply(state, [...placement.operations, { op: 'create', key: 'task', task: {
        title, parent, order: placement.order, ...(options.repo !== undefined ? { repo: options.repo } : {}),
      } }]);
    });

  command(program, 'edit <id>', 'replace full Markdown from a file or VISUAL/EDITOR')
    .option('-f, --file <file>', 'UTF-8 Markdown file; - reads stdin')
    .option('--if-version <version>', 'required with -f; expected file version')
    .action(async (id: string, options: { file?: string; ifVersion?: string }) => {
      if (options.file !== undefined && !options.ifVersion) {
        throw new TaskError('VERSION_REQUIRED', 'edit -f requires --if-version.', 'Use show <id> --json to obtain the current version.');
      }
      // Fully validate and bound input before any store mutation.
      const content = options.file !== undefined ? await inputFile(options.file) : undefined;
      const state = await getStore().state();
      taskIn(state, id);
      if (content === undefined) emit(await editInteractive(getStore(), state, id, options.ifVersion));
      else await apply(state, [{ op: 'replaceMarkdown', id, content, expectedVersion: options.ifVersion! }]);
    });

  command(program, 'start <id>', 'start a Ready task and bind DSH_SESSION_ID when present')
    .option('--if-version <version>', 'require this task version')
    .action(async (id: string, options: { ifVersion?: string }) => {
    const state = await getStore().state();
    const task = taskIn(state, id);
    await assertExpected(getStore(), id, options.ifVersion);
    if (task.archived) throw new TaskError('TASK_ARCHIVED', 'Restore the task before starting it.');
    if (task.status !== 'in_progress' && !state.ready.includes(id)) {
      throw new TaskError('TASK_NOT_READY', `Task ${id} is not Ready.`, 'Resolve dependencies and unfinished child tasks first.');
    }
    const result = await getStore().apply({
      requestId: randomUUID(), baseRevision: state.revision,
      operations: [await versionPatch(getStore(), task, { status: 'in_progress' })],
    });
    const sessionId = process.env.DSH_SESSION_ID;
    if (sessionId) {
      try { await getStore().bindSession(id, sessionId); }
      catch (error) {
        // `session_already_bound` arrives as the cause so a user can tell a
        // needs-confirmation rebind apart from a storage failure.
        throw new TaskError('SESSION_BIND_FAILED', 'Task is in_progress, but the session binding failed.',
          error instanceof TaskError && error.code === 'session_already_bound'
            ? 'The session is bound to another task; unbind it there first and retry start with DSH_SESSION_ID.'
            : 'Retry start with DSH_SESSION_ID to repair the binding.',
          { partial: true, taskId: id, status: 'in_progress', result, cause: errorEnvelope(error) });
      }
    }
    emit({ ...result, taskId: id, status: 'in_progress', sessionBound: Boolean(sessionId) });
  });

  command(program, 'status <id> <status>', 'set task status')
    .option('--if-version <version>', 'require this task version')
    .action(async (id: string, value: string, options: { ifVersion?: string }) => {
    const status = statusValue(value);
    const state = await getStore().state();
    await assertExpected(getStore(), id, options.ifVersion);
    await apply(state, [await versionPatch(getStore(), taskIn(state, id), { status })]);
  });

  command(program, 'move <id>', 'reparent or reorder a task')
    .option('--if-version <version>', 'require this task version')
    .addOption(new Option('--parent <id>', 'destination parent').conflicts('root'))
    .addOption(new Option('--root', 'move to the root').conflicts('parent'))
    .addOption(new Option('--before <id>', 'place before a destination sibling').conflicts('after'))
    .addOption(new Option('--after <id>', 'place after a destination sibling').conflicts('before'))
    .action(async (id: string, options: { parent?: string; root?: boolean; before?: string; after?: string; ifVersion?: string }) => {
      if (!options.parent && !options.root && !options.before && !options.after) {
        throw new TaskError('INVALID_ARGUMENT', 'move requires --parent, --root, --before, or --after.');
      }
      const state = await getStore().state();
      const task = taskIn(state, id);
      await assertExpected(getStore(), id, options.ifVersion);
      if (task.archived) throw new TaskError('TASK_ARCHIVED', 'Restore the task before moving it.');
      const parent = options.root ? null : options.parent ?? task.parent;
      const placement = await position(getStore(), state, parent, { moving: task, before: options.before, after: options.after });
      await apply(state, [...placement.operations, await versionPatch(getStore(), task, { parent, order: placement.order })]);
    });

  // An argument-bearing parent command is ambiguous in commander; parse the approved layout directly.
  command(program, 'deps <id> <action> <ids...>', 'deps <id> add|remove <dependency IDs...>')
    .option('--if-version <version>', 'require this task version')
    .action(async (id: string, action: string, ids: string[], options: { ifVersion?: string }) => {
      if (action !== 'add' && action !== 'remove') throw new TaskError('INVALID_ARGUMENT', 'Dependency action must be add or remove.');
      const state = await getStore().state();
      const task = taskIn(state, id);
      await assertExpected(getStore(), id, options.ifVersion);
      if (action === 'add') for (const dependency of ids) taskIn(state, dependency);
      const blocked_by = action === 'add'
        ? [...new Set([...task.blocked_by, ...ids])].sort(byteCompare)
        : task.blocked_by.filter((dependency) => !ids.includes(dependency));
      await apply(state, [await versionPatch(getStore(), task, { blocked_by })]);
    });

  for (const action of ['archive', 'restore'] as const) {
    command(program, `${action} <id>`, `${action} a task subtree`)
      .option('--if-version <version>', 'require this task version')
      .action(async (id: string, options: { ifVersion?: string }) => {
      const state = await getStore().state();
      await assertExpected(getStore(), id, options.ifVersion);
      const targets = new Set([id, ...descendants(state.tasks, id)]);
      if (action === 'restore') {
        let parent = taskIn(state, id).parent;
        while (parent && !targets.has(parent)) {
          targets.add(parent);
          parent = taskIn(state, parent).parent;
        }
      }
      const guards: Operation[] = [];
      for (const taskId of targets) guards.push(await versionPatch(getStore(), taskIn(state, taskId), {}));
      await apply(state, [...guards, { op: action, id }]);
    });
  }

  command(program, 'delete <id>', 'delete a canceled or archived task without dependencies or children')
    .option('--if-version <version>', 'require this task version')
    .action(async (id: string, options: { ifVersion?: string }) => {
      const state = await getStore().state();
      await assertExpected(getStore(), id, options.ifVersion);
      const record = await getStore().read(id);
      await apply(state, [{ op: 'delete', id, expectedVersion: record.version }]);
    });

  command(program, 'apply', 'apply a validated, recoverable JSON batch plan')
    .requiredOption('-f, --file <file>', 'JSON plan file; - reads stdin')
    .addHelpText('after', '\nRead baseRevision with taskmd list --json. Operations: create, patch, replaceMarkdown, archive, restore, delete.\n'
      + 'Example plan (replace CURRENT_REVISION with the returned revision):\n'
      + JSON.stringify({ requestId: 'unique-request-id', baseRevision: 'CURRENT_REVISION', operations: [
        { op: 'create', key: 'parent', task: { title: 'Release' } },
        { op: 'create', task: { title: 'Prepare release notes', parent: { key: 'parent' } } },
      ] }, null, 2) + '\nMarkdown replacement requires expectedVersion from taskmd show <id> --json.\n')
    .action(async (options: { file: string }) => {
      const plan = parsePlan(await inputFile(options.file, PLAN_INPUT_LIMIT));
      emit(await getStore().apply(plan));
    });

  command(program, 'serve', 'serve the standalone task frontend and HTTP API')
    .option('--host <host>', 'listen address', '127.0.0.1')
    .option('--port <port>', 'listen port (0 assigns a free port)', (value) => integer(value, 0, 65535), 4738)
    .action(async (options: { host: string; port: number }) => {
      const running = await startServer(getStore(), options);
      emit({ schemaVersion: 1, url: running.url }, `taskmd listening at ${running.url}`);
      await new Promise<void>((resolveServer, reject) => {
        const stop = () => {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
          void running.close().then(resolveServer, reject);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  try {
    if (argv.length <= 2) program.help();
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    const failure = error instanceof CommanderError
      ? new TaskError('INVALID_ARGUMENT', error.message, 'Use taskmd --help for command syntax.')
      : error;
    const envelope = errorEnvelope(failure);
    process.stderr.write(json() ? `${JSON.stringify(envelope)}\n`
      : `${envelope.code}: ${envelope.message}${envelope.hint ? `\n${envelope.hint}` : ''}${envelope.details !== undefined ? `\n${JSON.stringify(envelope.details)}` : ''}\n`);
    process.exitCode = 1;
  } finally {
    store?.close();
  }
}
