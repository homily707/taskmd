import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskFiles } from '../src/core/files.js';
import { TaskError, type HomeSettings } from '../src/types.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'taskmd-files-'));
  const home = join(root, 'home'); const localDirectory = join(root, 'local');
  await mkdir(home);
  const files = new TaskFiles({ localDirectory });
  t.after(async () => {
    files.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '/taskmd-files-'));
    await rm(root, { recursive: true, force: true });
  });
  await files.init();
  const settings: HomeSettings = { homeDirectory: home, homeWorkspaceId: 'home-ws', tasksDirectory: 'tasks' };
  await files.configure(settings);
  return { root, home, localDirectory, files, settings };
}
const errorCode = (expected: string) => (error: unknown) => error instanceof TaskError && error.code === expected;

test('unconfigured Home has empty state; settings persist and custom directory stays inside Home', async t => {
  const { files, home, localDirectory, settings } = await fixture(t);
  await files.configure({ homeDirectory: '', homeWorkspaceId: null, tasksDirectory: 'tasks' });
  assert.deepEqual(await files.state(), { settings: { homeDirectory: '', homeWorkspaceId: null, tasksDirectory: 'tasks' }, tasks: [], diagnostics: [] });
  await assert.rejects(files.create({ title: 'No Home' }), errorCode('not_configured'));
  await files.configure({ ...settings, tasksDirectory: 'notes/work' });
  const record = await files.create({ title: 'Here' });
  assert.equal(record.path, join(await realpath(home), 'notes/work', `Here--${record.task.id.slice(0, 8)}.md`));
  const reopened = new TaskFiles({ localDirectory }); t.after(() => reopened.close());
  await reopened.init();
  assert.equal((await reopened.state()).settings.tasksDirectory, 'notes/work');
  for (const tasksDirectory of ['../outside', '/absolute', '.', 'nested/../../escape', 'nested\\escape']) {
    await assert.rejects(files.configure({ ...settings, tasksDirectory }), errorCode('invalid_settings'));
  }
  assert.equal((await files.state()).settings.tasksDirectory, 'notes/work');
});

test('only marked documents are imported and malformed managed files are diagnosed', async t => {
  const { files, home } = await fixture(t);
  const generated = await files.create({ title: 'Generated', body: '# Body\n' });
  assert.match(generated.content, /^---\ntaskmd: 0\.3\n/);
  assert.match(generated.task.id, /^[0-9a-f-]{36}$/);
  await writeFile(join(home, 'tasks', 'notes.md'), '# Ordinary note');
  await writeFile(join(home, 'tasks', `${randomUUID()}.md`), '---\nschema: 1\ntitle: Legacy\n---\n');
  assert.equal((await files.state()).tasks.length, 1);
  assert.equal((await files.state()).diagnostics.length, 0);
  await writeFile(join(home, 'tasks', 'wrong-name.md'), generated.content);
  await writeFile(join(home, 'tasks', `${randomUUID()}.md`), generated.content.replace('status: todo', 'status: unknown'));
  const state = await files.state();
  assert.equal(state.tasks.length, 1); assert.equal(state.diagnostics.length, 2);
  await writeFile(generated.path, generated.content.replace('Generated', 'Externally edited'));
  assert.equal((await files.read(generated.task.id)).task.title, 'Externally edited');
});

test('conditional update and deletion preserve external edits and report latest version', async t => {
  const { files } = await fixture(t);
  const record = await files.create({ title: 'Draft', body: 'original' });
  await writeFile(record.path, record.content.replace('original', 'external'));
  const current = await files.read(record.task.id);
  await assert.rejects(files.update(record.task.id, { body: 'my draft' }, record.version), error => {
    assert.ok(errorCode('version_conflict')(error));
    assert.deepEqual((error as TaskError).details, { latestVersion: current.version }); return true;
  });
  await assert.rejects(files.remove(record.task.id, record.version), errorCode('version_conflict'));
  assert.equal(await readFile(record.path, 'utf8'), current.content);
  const updated = await files.update(record.task.id, { body: 'merged draft' }, current.version);
  assert.equal(updated.task.body, 'merged draft');
  assert.notEqual(updated.version, current.version);
  await files.remove(updated.task.id, updated.version);
  await assert.rejects(files.read(updated.task.id), errorCode('not_found'));
});

test('conflict is reported even when an external edit removes the marker or breaks YAML', async t => {
  const { files } = await fixture(t);
  const record = await files.create({ title: 'External damage' });
  for (const content of ['ordinary markdown now', '---\ntaskmd: 0.3\ntitle: [broken\n---\n']) {
    await writeFile(record.path, content);
    await assert.rejects(files.update(record.task.id, { body: 'draft' }, record.version), errorCode('version_conflict'));
    await assert.rejects(files.remove(record.task.id, record.version), errorCode('version_conflict'));
    assert.equal(await readFile(record.path, 'utf8'), content);
  }
});

test('two instances serialize updates and JSON bindings without losing writes', async t => {
  const { files, localDirectory } = await fixture(t);
  const other = new TaskFiles({ localDirectory }); t.after(() => other.close()); await other.init();
  const record = await files.create({ title: 'Concurrent' });
  const results = await Promise.allSettled([
    files.update(record.task.id, { title: 'One' }, record.version),
    other.update(record.task.id, { title: 'Two' }, record.version),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(errorCode('version_conflict')(failure.reason));
  await Promise.all([files.bind(record.task.id, 'session-a'), other.bind(record.task.id, 'session-b')]);
  assert.equal((await files.bindings()).length, 2);
});

test('parent structure is enforced without state, cancellation, or archive cascades', async t => {
  const { files } = await fixture(t);
  const parent = await files.create({ title: 'Parent' });
  const child = await files.create({ title: 'Child', parent: parent.task.id });
  const grandchild = await files.create({ title: 'Grandchild', parent: child.task.id });
  await assert.rejects(files.create({ title: 'Orphan', parent: randomUUID() }), errorCode('invalid_parent'));
  await assert.rejects(files.update(parent.task.id, { parent: grandchild.task.id }, parent.version), errorCode('invalid_parent'));
  await assert.rejects(files.update(child.task.id, { parent: child.task.id }, child.version), errorCode('invalid_parent'));
  const done = await files.update(parent.task.id, { status: 'done', archived: true }, parent.version);
  assert.deepEqual((await files.read(child.task.id)).task, child.task);
  await files.create({ title: 'New child of archived done parent', parent: parent.task.id });
  const restored = await files.update(parent.task.id, { archived: false, status: 'canceled' }, done.version);
  assert.equal((await files.read(child.task.id)).task.status, 'todo');
  await files.bind(child.task.id, 'session-child'); await files.bind(grandchild.task.id, 'session-grandchild');
  const deleted = await files.remove(parent.task.id, restored.version);
  assert.equal(deleted.length, 4);
  assert.ok(deleted.includes(parent.task.id) && deleted.includes(child.task.id) && deleted.includes(grandchild.task.id));
  await assert.rejects(files.read(parent.task.id), errorCode('not_found'));
  await assert.rejects(files.read(child.task.id), errorCode('not_found'));
  assert.deepEqual(await files.bindings(), []);
  const orphanHost = await files.create({ title: 'Orphan host' });
  const orphan = await files.create({ title: 'Orphan', parent: orphanHost.task.id });
  await writeFile(orphan.path, orphan.content.replace(`parent: ${orphanHost.task.id}`, `parent: ${randomUUID()}`));
  assert.ok((await files.state()).diagnostics.some(item => item.message.includes('does not exist')));
  await files.update(orphan.task.id, { parent: null }, (await files.read(orphan.task.id)).version);
  assert.equal((await files.state()).diagnostics.length, 0);
});

test('numeric order sorts with UUID tie break and invalid changes are rejected', async t => {
  const { files } = await fixture(t);
  const a = await files.create({ title: 'A' }); const b = await files.create({ title: 'B' });
  assert.equal(b.task.order, a.task.order + 1);
  await files.update(a.task.id, { order: -2 }, a.version);
  await files.update(b.task.id, { order: -2 }, b.version);
  assert.deepEqual((await files.state()).tasks.map(item => item.task.id), [a.task.id, b.task.id].sort());
  const current = await files.read(a.task.id);
  for (const order of [NaN, Infinity, 0.5]) await assert.rejects(files.update(a.task.id, { order }, current.version), errorCode('invalid_document'));
  await assert.rejects(files.create({ title: '  ' }), errorCode('invalid_document'));
  await assert.rejects(files.update(a.task.id, { repo: 'old' } as never, current.version), errorCode('invalid_document'));
});

test('bindings persist locally, partition by canonical task directory, and delete cleans only its task', async t => {
  const { files, home, root, settings, localDirectory } = await fixture(t);
  const one = await files.create({ title: 'One' }); const two = await files.create({ title: 'Two' });
  await files.bind(one.task.id, 'session-1'); await files.bind(one.task.id, 'session-1');
  await files.bind(two.task.id, 'session-2');
  await files.bind(two.task.id, 'session-1');
  assert.equal((await files.bindings(one.task.id)).length, 0);
  assert.equal((await files.bindings(two.task.id)).length, 2);
  await files.bind(one.task.id, 'session-1');
  assert.equal((await files.bindings(one.task.id)).length, 1);
  assert.equal(await files.touch('missing'), false); assert.equal(await files.touch('session-1'), true);
  assert.ok((await files.bindings(one.task.id))[0]?.lastOpenedAt);
  assert.equal((await files.read(one.task.id)).version, one.version);
  await files.configure({ ...settings, tasksDirectory: 'other' });
  assert.deepEqual(await files.bindings(), []);
  const other = await files.create({ title: 'Other' }); await files.bind(other.task.id, 'session-1');
  await files.configure(settings);
  assert.equal((await files.bindings()).length, 2);
  const alias = join(root, 'home-alias'); await symlink(home, alias);
  await files.configure({ ...settings, homeDirectory: alias });
  assert.equal((await files.bindings()).length, 2);
  await files.remove(one.task.id, one.version);
  assert.deepEqual((await files.bindings()).map(item => item.sessionId), ['session-2']);
  await files.unbind(two.task.id, 'session-2'); assert.deepEqual(await files.bindings(), []);
  assert.ok(JSON.parse(await readFile(join(localDirectory, 'bindings.json'), 'utf8')));
  assert.equal((await files.read(two.task.id)).task.status, 'todo');
});

test('attachments accept relative Home files and reject traversal, symlink escapes, unsafe types, and size', async t => {
  const { files, home, root } = await fixture(t);
  const task = await files.create({ title: 'Attachments' });
  await mkdir(join(home, 'assets'));
  await writeFile(join(home, 'assets', 'read me.md'), 'attachment body');
  assert.equal((await files.attachment(task.task.id, '../assets/read%20me.md#section')).content, 'attachment body');
  await writeFile(join(home, 'assets', 'image.png'), Buffer.from([137, 80, 78, 71]));
  assert.match((await files.attachment(task.task.id, '../assets/image.png')).dataUrl!, /^data:image\/png;base64,/);
  await writeFile(join(root, 'private.txt'), 'outside');
  await symlink(join(root, 'private.txt'), join(home, 'assets', 'escape.txt'));
  for (const href of ['../../private.txt', '../assets/escape.txt', '%2e%2e/%2e%2e/private.txt']) {
    await assert.rejects(files.attachment(task.task.id, href), errorCode('path_outside_home'));
  }
  for (const href of ['/etc/passwd', 'https://example.com/a.png', 'file:///x', '..\\private.txt', '%00']) {
    await assert.rejects(files.attachment(task.task.id, href), errorCode('invalid_attachment'));
  }
  await writeFile(join(home, 'assets', 'unsafe.svg'), '<svg/>');
  await assert.rejects(files.attachment(task.task.id, '../assets/unsafe.svg'), errorCode('unsupported_attachment'));
  await writeFile(join(home, 'assets', 'large.txt'), Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(files.attachment(task.task.id, '../assets/large.txt'), errorCode('file_too_large'));
});

test('tasks-directory symlink escape is rejected before writing and after external replacement', async t => {
  const { files, root, home, settings } = await fixture(t);
  const outside = join(root, 'outside'); await mkdir(outside);
  await symlink(outside, join(home, 'escaped'));
  await assert.rejects(files.configure({ ...settings, tasksDirectory: 'escaped/subdir' }), errorCode('path_outside_home'));
  await assert.rejects(readFile(join(outside, 'subdir')), { code: 'ENOENT' });
  await rename(join(home, 'tasks'), join(home, 'saved-tasks'));
  await symlink(outside, join(home, 'tasks'));
  await assert.rejects(files.state(), errorCode('path_outside_home'));
  await assert.rejects(files.create({ title: 'Escape' }), errorCode('path_outside_home'));
});

test('malformed managed children prevent unsafe leaf deletion and corrupt local JSON is preserved', async t => {
  const { files, localDirectory } = await fixture(t);
  const parent = await files.create({ title: 'Parent' });
  const child = await files.create({ title: 'Child', parent: parent.task.id });
  await writeFile(child.path, child.content.replace('status: todo', 'status: invalid'));
  await assert.rejects(files.remove(parent.task.id, parent.version), errorCode('invalid_structure'));
  assert.equal((await files.read(parent.task.id)).version, parent.version);
  await writeFile(join(localDirectory, 'bindings.json'), '{ invalid');
  await assert.rejects(files.bind(parent.task.id, 's'), errorCode('invalid_local_data'));
  assert.equal(await readFile(join(localDirectory, 'bindings.json'), 'utf8'), '{ invalid');
});

test('external atomic file replacement notifies subscribers and close releases polling', async t => {
  const { files } = await fixture(t);
  const record = await files.create({ title: 'Watch', body: 'before' });
  await files.init(); // Establish the created file as the baseline before the external edit.
  const notification = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('No external-change notification')); }, 4000);
    const unsubscribe = files.subscribe(() => { clearTimeout(timeout); unsubscribe(); resolve(); });
  });
  const temporary = `${record.path}.replacement`;
  await writeFile(temporary, record.content.replace('before', 'after!'));
  assert.ok(resolve(temporary).startsWith(resolve(record.path)));
  await rename(temporary, record.path);
  await notification;
  assert.equal((await files.read(record.task.id)).task.body, 'after!');
  files.close();
  let called = false; files.subscribe(() => { called = true; });
  await files.update(record.task.id, { title: 'Closed watcher' }, (await files.read(record.task.id)).version);
  assert.equal(called, false);
});


test('offline Home does not prevent explicit configuration recovery on startup', async t => {
  const { files, home, root, localDirectory } = await fixture(t);
  files.close();
  const moved = join(root, 'home-offline');
  assert.equal(home, join(root, 'home'));
  await rename(home, moved);
  const reopened = new TaskFiles({ localDirectory }); t.after(() => reopened.close());
  await reopened.init();
  await assert.rejects(reopened.state());
  const state = await reopened.configure({ homeDirectory: moved, homeWorkspaceId: 'other', tasksDirectory: 'tasks' });
  assert.equal(state.settings.homeDirectory, moved);
  assert.equal((await reopened.create({ title: 'Recovered' })).task.title, 'Recovered');
});

test('retrying deletion cleans stale bindings after the Markdown has already gone', async t => {
  const { files, home } = await fixture(t);
  const record = await files.create({ title: 'Delete' });
  await files.bind(record.task.id, 'session');
  assert.equal(record.path, join(await realpath(home), 'tasks', `Delete--${record.task.id.slice(0, 8)}.md`));
  await rm(record.path);
  assert.equal((await files.bindings()).length, 1);
  await files.remove(record.task.id, record.version);
  await files.remove(record.task.id, record.version);
  assert.deepEqual(await files.bindings(), []);
});

test('filenames use the title with a short ID while the frontmatter UUID stays canonical', async t => {
  const { files } = await fixture(t);
  const record = await files.create({ title: '设计方案/第一版', body: 'body' });
  assert.equal(basename(record.path), `设计方案-第一版--${record.task.id.slice(0, 8)}.md`);
  assert.equal((await files.read(record.task.id)).task.id, record.task.id);
  assert.equal((await files.state()).tasks[0]!.path, record.path);
});

test('title changes rename the file without changing task identity or bindings', async t => {
  const { files } = await fixture(t);
  const record = await files.create({ title: 'Old title' });
  await files.bind(record.task.id, 'session-1');
  const updated = await files.update(record.task.id, { title: 'New title' }, record.version);
  assert.equal(basename(updated.path), `New title--${record.task.id.slice(0, 8)}.md`);
  assert.notEqual(updated.path, record.path);
  await assert.rejects(readFile(record.path), { code: 'ENOENT' });
  assert.equal((await files.read(record.task.id)).task.title, 'New title');
  assert.equal((await files.bindings(record.task.id))[0]!.sessionId, 'session-1');
});

test('duplicate task IDs are diagnosed instead of listing the task twice', async t => {
  const { files, home } = await fixture(t);
  const record = await files.create({ title: 'Unique' });
  await writeFile(join(home, 'tasks', 'copy.md'), record.content);
  const state = await files.state();
  assert.equal(state.tasks.length, 1);
  assert.ok(state.diagnostics.some(item => item.message.includes('duplicate_id') || item.message.includes('also used')));
});

test('duplicate titles remain distinct and old UUID filenames stay readable', async t => {
  const { files } = await fixture(t);
  const first = await files.create({ title: 'Same' });
  const second = await files.create({ title: 'Same' });
  assert.notEqual(first.path, second.path);
  assert.match(basename(first.path), /^Same--[0-9a-f]{8}\.md$/);
  assert.match(basename(second.path), /^Same--[0-9a-f]{8}\.md$/);
  const legacyPath = join(dirname(first.path), `${first.task.id}.md`);
  await rename(first.path, legacyPath);
  assert.equal((await files.read(first.task.id)).path, legacyPath);
  assert.equal((await files.state()).tasks.find(record => record.task.id === first.task.id)!.path, legacyPath);
});
