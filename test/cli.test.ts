import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withSandbox, cliJson, createTask, runCli, localStateDirectory } from './helpers.js';

test('cli list --json has the documented envelope', async () => {
  await withSandbox(async (sandbox) => {
    const empty = await cliJson(sandbox, ['list']);
    assert.equal(empty.schemaVersion, 1);
    assert.equal(typeof empty.revision, 'string');
    assert.equal(empty.revision.length, 64);
    assert.deepEqual(empty.tasks, []);

    const id = await createTask(sandbox, 'CLI 列表');
    const listed = await cliJson(sandbox, ['list']);
    assert.equal(listed.schemaVersion, 1);
    assert.equal(listed.tasks.length, 1);
    const [task] = listed.tasks as Array<Record<string, unknown>>;
    assert.equal(task!.id, id);
    assert.equal(task!.title, 'CLI 列表');
    assert.equal(task!.status, 'todo');
    assert.equal(task!.parent, null);
    assert.equal(task!.archived, false);
    assert.equal(typeof task!.order, 'string');
    // `list --json` deliberately carries the full body; `metadataState` must not.
    assert.equal(typeof task!.body, 'string');
    // Creating a task changes the store revision.
    assert.notEqual(listed.revision, empty.revision);
  });
});

test('cli show --json returns task, content and version', async () => {
  await withSandbox(async (sandbox) => {
    const id = await createTask(sandbox, 'CLI 详情');
    const shown = await cliJson(sandbox, ['show', id]);
    assert.equal(shown.schemaVersion, 1);
    assert.equal(typeof shown.revision, 'string');
    assert.equal(typeof shown.version, 'string');
    assert.equal(shown.version.length, 64);
    assert.equal(shown.content, await readFile(join(sandbox.store, 'tasks', `${id}.md`), 'utf8'));
    const task = shown.task as Record<string, unknown>;
    assert.equal(task.id, id);
    assert.equal(task.title, 'CLI 详情');
    assert.equal(task.status, 'todo');
    assert.equal(typeof task.body, 'string');

    // show --raw prints the Markdown itself, not JSON.
    const raw = await runCli(sandbox, ['show', id, '--raw']);
    assert.equal(raw.code, 0);
    assert.equal(raw.stdout, shown.content);
  });
});

test('cli start --json reports the in_progress task and binds DSH_SESSION_ID', async () => {
  await withSandbox(async (sandbox) => {
    const id = await createTask(sandbox, 'CLI 开始');
    const started = await cliJson(sandbox, ['start', id], { DSH_SESSION_ID: 'session-cli-1' });
    assert.equal(started.schemaVersion, 1);
    assert.equal(started.taskId, id);
    assert.equal(started.status, 'in_progress');
    assert.equal(started.sessionBound, true);
    assert.equal(typeof started.requestId, 'string');
    assert.equal(typeof started.revision, 'string');
    assert.equal((started.versions as Record<string, string>)[id]!.length, 64);

    const bindings = JSON.parse(
      await readFile(join(await localStateDirectory(sandbox), 'sessions.json'), 'utf8'),
    ) as Array<Record<string, unknown>>;
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]!.taskId, id);
    assert.equal(bindings[0]!.sessionId, 'session-cli-1');

    // Without DSH_SESSION_ID the same command reports an unbound session.
    const second = await createTask(sandbox, 'CLI 开始 2');
    const plain = await cliJson(sandbox, ['start', second]);
    assert.equal(plain.sessionBound, false);
  });
});

test('cli start reports a session bound to another task without stealing it', async () => {
  await withSandbox(async (sandbox) => {
    const owner = await createTask(sandbox, 'CLI 会话归属');
    await cliJson(sandbox, ['start', owner], { DSH_SESSION_ID: 'session-shared' });

    const other = await createTask(sandbox, 'CLI 会话冲突');
    const failed = await runCli(sandbox, ['--json', 'start', other], { DSH_SESSION_ID: 'session-shared' });
    assert.equal(failed.code, 1);
    const error = JSON.parse(failed.stderr.trim()) as Record<string, any>;
    assert.equal(error.code, 'SESSION_BIND_FAILED');
    assert.equal(error.details.partial, true);
    assert.equal(error.details.status, 'in_progress');
    assert.equal(error.details.cause.code, 'session_already_bound');
    assert.equal(error.details.cause.details.existingTaskId, owner);
    assert.equal(error.details.cause.details.taskId, other);

    // The task did start, but the binding stayed with its original owner.
    assert.equal(((await cliJson(sandbox, ['show', other])).task as Record<string, unknown>).status, 'in_progress');
    const bindings = JSON.parse(
      await readFile(join(await localStateDirectory(sandbox), 'sessions.json'), 'utf8'),
    ) as Array<Record<string, unknown>>;
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]!.taskId, owner);
    assert.equal(bindings[0]!.sessionId, 'session-shared');
  });
});

test('cli start --if-version mismatch returns VERSION_CONFLICT', async () => {
  await withSandbox(async (sandbox) => {
    const id = await createTask(sandbox, 'CLI 版本冲突');
    const failed = await runCli(sandbox, ['--json', 'start', id, '--if-version', 'f'.repeat(64)]);
    assert.equal(failed.code, 1);
    const error = JSON.parse(failed.stderr.trim()) as Record<string, unknown>;
    assert.equal(error.schemaVersion, 1);
    assert.equal(error.code, 'VERSION_CONFLICT');
    assert.equal(typeof error.message, 'string');
    assert.equal((error.details as Record<string, unknown>).taskId, id);

    // The rejected command did not change the task.
    const shown = await cliJson(sandbox, ['show', id]);
    assert.equal((shown.task as Record<string, unknown>).status, 'todo');
  });
});

test('cli start rejects a task that is not Ready', async () => {
  await withSandbox(async (sandbox) => {
    const blocker = await createTask(sandbox, '阻塞项');
    const dependent = await createTask(sandbox, '被阻塞');
    const ok = await runCli(sandbox, ['--json', 'deps', dependent, 'add', blocker]);
    assert.equal(ok.code, 0, ok.stderr);
    const failed = await runCli(sandbox, ['--json', 'start', dependent]);
    assert.equal(failed.code, 1);
    assert.equal((JSON.parse(failed.stderr.trim()) as Record<string, unknown>).code, 'TASK_NOT_READY');
  });
});
