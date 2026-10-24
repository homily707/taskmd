import test from 'node:test';
import assert from 'node:assert/strict';
import { matchWorkspace, type WorkspaceLike } from '../src/core/workspace-match.js';
import { contextCommand, initialPrompt } from '../src/ui/prompt.js';

const workspace = (workspaceId: string, path: string, title = path.split('/').at(-1) ?? workspaceId): WorkspaceLike =>
  ({ workspaceId, path, title });

const repos: WorkspaceLike[] = [
  workspace('w1', '/Users/me/code/harless'),
  workspace('w2', '/Users/me/code/other'),
  workspace('w3', '/Users/me/code/third', 'harless'),
];

test('a task without a repository is never matched automatically', () => {
  const result = matchWorkspace({ name: null, directory: null }, repos);
  assert.deepEqual(result, { kind: 'none', reason: 'no-repo' });
  // An empty or blank repo name is the same case, not a name match on everything.
  assert.deepEqual(matchWorkspace({ name: '   ', directory: '/Users/me/code/harless' }, repos), { kind: 'none', reason: 'no-repo' });
});

test('a repository path equal to a workspace path wins over a name collision', () => {
  const result = matchWorkspace({ name: 'harless', directory: '/Users/me/code/harless' }, repos);
  assert.equal(result.kind, 'matched');
  assert.equal(result.kind === 'matched' && result.workspace.workspaceId, 'w1');
  // Trailing separators must not defeat path equality.
  const trailing = matchWorkspace({ name: 'harless', directory: '/Users/me/code/harless/' }, repos);
  assert.equal(trailing.kind, 'matched');
  assert.equal(trailing.kind === 'matched' && trailing.workspace.workspaceId, 'w1');
});

test('a workspace title equal to the repository name matches when the path does not', () => {
  // The registry path does not exist as a Workspace path, so the title decides.
  const result = matchWorkspace({ name: 'third', directory: '/elsewhere/third' }, repos);
  assert.equal(result.kind, 'matched');
  assert.equal(result.kind === 'matched' && result.workspace.workspaceId, 'w3');
});

test('a path basename equal to the repository name matches as a last resort', () => {
  const result = matchWorkspace({ name: 'other', directory: '/not/a/workspace' }, repos);
  assert.equal(result.kind, 'matched');
  assert.equal(result.kind === 'matched' && result.workspace.workspaceId, 'w2');
});

test('an ambiguous name match returns every candidate instead of picking the first', () => {
  const ambiguous = [workspace('a', '/one/harless'), workspace('b', '/two/harless')];
  const result = matchWorkspace({ name: 'harless', directory: '/somewhere/else' }, ambiguous);
  assert.equal(result.kind, 'candidates');
  assert.deepEqual(result.kind === 'candidates' && result.list.map(item => item.workspaceId), ['a', 'b']);
});

test('an unmatched repository lists every workspace as a candidate', () => {
  const result = matchWorkspace({ name: 'unrelated', directory: '/nowhere/unrelated' }, repos);
  assert.equal(result.kind, 'candidates');
  assert.equal(result.kind === 'candidates' && result.list.length, 3);
});

test('zero workspaces is reported as none rather than an empty candidate list', () => {
  assert.deepEqual(matchWorkspace({ name: 'harless', directory: '/Users/me/code/harless' }, []), { kind: 'none', reason: 'no-workspaces' });
});

test('a missing repository mapping still allows a name match', () => {
  const result = matchWorkspace({ name: 'harless', directory: null }, repos);
  assert.equal(result.kind, 'candidates', 'two workspace names are "harless": the path basename and the title');
  const single = matchWorkspace({ name: 'other', directory: null }, repos);
  assert.equal(single.kind, 'matched');
  assert.equal(single.kind === 'matched' && single.workspace.workspaceId, 'w2');
});

test('the default prompt names the task and points at the context command', () => {
  const text = initialPrompt({ id: 'task-1', title: '修好登录', repo: 'harless' });
  assert.match(text, /修好登录/);
  assert.match(text, /task-1/);
  assert.match(text, /harless/);
  assert.match(text, new RegExp(contextCommand('task-1')));
  // A task without a repo must not print an empty repository line.
  assert.doesNotMatch(initialPrompt({ id: 'task-2', title: '无仓库任务' }), /仓库：/);
});
