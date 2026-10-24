import test from 'node:test';
import assert from 'node:assert/strict';
import { createOptions, describeFailure, resolveTarget, type Target } from '../src/ui/session-target.js';

test('a workspace target sends workspaceId and never directory', () => {
  const target: Target = { kind: 'workspace', workspaceId: 'w-1', label: 'harless' };
  const options = createOptions(target);
  assert.deepEqual(options, { workspaceId: 'w-1' });
  assert.ok(!('directory' in options), 'workspaceId and directory are mutually exclusive');
});

test('a directory target sends directory and never workspaceId', () => {
  const options = createOptions({ kind: 'directory', cwd: '/Users/me/code/harless', label: 'x' });
  assert.deepEqual(options, { directory: '/Users/me/code/harless' });
  assert.ok(!('workspaceId' in options));
});

test('a preset rides along, and a blank preset is omitted rather than sent empty', () => {
  assert.deepEqual(createOptions({ kind: 'directory', cwd: '/a', label: 'a' }, 'reviewer'), { directory: '/a', agentPreset: 'reviewer' });
  assert.deepEqual(createOptions({ kind: 'directory', cwd: '/a', label: 'a' }, '   '), { directory: '/a' });
  assert.deepEqual(createOptions({ kind: 'workspace', workspaceId: 'w', label: 'w' }, ' reviewer '), { workspaceId: 'w', agentPreset: 'reviewer' });
});

test('a created-but-unbound session keeps its id so the UI can retry binding', () => {
  const error = Object.assign(new Error('会话 s-1 已创建，但绑定到任务失败'), {
    code: 'session_bind_failed',
    details: { sessionId: 's-1' },
  });
  const failure = describeFailure(error);
  assert.equal(failure.code, 'session_bind_failed');
  assert.equal(failure.sessionId, 's-1');
  assert.match(failure.message, /s-1/);
});

test('session_already_bound carries the owning task for a confirmation prompt', () => {
  const error = Object.assign(new Error('Session s-2 is already bound to task task-9.'), {
    code: 'session_already_bound',
    details: { taskId: 'task-x', existingTaskId: 'task-9', sessionId: 's-2' },
  });
  const failure = describeFailure(error);
  assert.equal(failure.existingTaskId, 'task-9');
});

test('a plain error becomes a readable failure without inventing ids', () => {
  const failure = describeFailure(new Error('boom'));
  assert.deepEqual(failure, { message: 'boom' });
  // Non-Error throwables still render.
  assert.deepEqual(describeFailure('plain string'), { message: 'plain string' });
  // A malformed details bag is ignored rather than trusted.
  assert.deepEqual(describeFailure(Object.assign(new Error('x'), { details: { sessionId: 42 } })), { message: 'x' });
});

test('a typed directory overrides every automatic choice', () => {
  const target = resolveTarget({
    manual: '/manual/dir', chosen: 'w-picked',
    match: { kind: 'matched', workspace: { workspaceId: 'w-auto', path: '/auto', title: 'auto' } },
    workspaces: [{ workspaceId: 'w-picked', path: '/picked', title: 'picked' }],
    directory: '/repo',
  });
  assert.deepEqual(target, { kind: 'directory', cwd: '/manual/dir', label: '/manual/dir' });
});

test('a picked workspace beats the automatic match', () => {
  const target = resolveTarget({
    manual: '', chosen: 'w-picked',
    match: { kind: 'matched', workspace: { workspaceId: 'w-auto', path: '/auto', title: 'auto' } },
    workspaces: [{ workspaceId: 'w-picked', path: '/picked', title: 'picked' }],
    directory: '/repo',
  });
  assert.deepEqual(target, { kind: 'workspace', workspaceId: 'w-picked', label: 'picked（/picked）' });
});

test('an automatic match is used when the user chose nothing', () => {
  const target = resolveTarget({
    manual: '', chosen: '',
    match: { kind: 'matched', workspace: { workspaceId: 'w-auto', path: '/auto', title: 'auto' } },
    workspaces: [], directory: '/repo',
  });
  assert.equal(target?.kind, 'workspace');
});

test('an ambiguous match never becomes a target by itself', () => {
  const target = resolveTarget({
    manual: '', chosen: '',
    match: { kind: 'candidates', list: [{ workspaceId: 'a', path: '/a', title: 'a' }, { workspaceId: 'b', path: '/b', title: 'b' }] },
    workspaces: [{ workspaceId: 'a', path: '/a', title: 'a' }], directory: '/repo',
  });
  // It falls through to the repository directory, which the Host accepts as cwd.
  assert.deepEqual(target, { kind: 'directory', cwd: '/repo', label: '/repo' });
});

test('a client without workspaces falls back to the repository directory', () => {
  const target = resolveTarget({ manual: '', chosen: '', match: { kind: 'none', reason: 'no-workspaces' }, workspaces: [], directory: '/repo' });
  assert.deepEqual(target, { kind: 'directory', cwd: '/repo', label: '/repo' });
  // Nothing to target at all: no repo, no workspaces, no manual path.
  assert.equal(resolveTarget({ manual: '', chosen: '', match: { kind: 'none', reason: 'no-repo' }, workspaces: [], directory: null }), undefined);
});

test('an ambiguous match with a typed choice becomes that workspace', () => {
  const workspaces = [{ workspaceId: 'a', path: '/a', title: 'a' }, { workspaceId: 'b', path: '/b', title: 'b' }];
  const target = resolveTarget({ manual: '', chosen: 'b', match: { kind: 'candidates', list: workspaces }, workspaces, directory: '/repo' });
  assert.deepEqual(target, { kind: 'workspace', workspaceId: 'b', label: 'b（/b）' });
});
