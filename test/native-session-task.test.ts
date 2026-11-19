import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskRecord, TaskSessionBinding } from '../src/types.js';
import { bindNativeSessionTask, type NativeDraftActions } from '../src/ui/native-session-task.js';

function record(id = 'task-1'): TaskRecord {
  return {
    task: { id, title: 'Existing task', body: '## 目标\n保存进展', status: 'todo', parent: null, archived: false, order: 0 },
    version: 'v1', content: '', path: `/home/tasks/${id}.md`,
  };
}
function fixture(options: { draft?: string; bindings?: TaskSessionBinding[]; changed?: boolean; selected?: boolean } = {}) {
  const edits: string[] = [];
  const bound: [string, string][] = [];
  const calls: string[] = [];
  const target = record();
  const editor: NativeDraftActions = {
    captureInsertion() { calls.push('capture'); return { start: 0, end: options.selected ? 3 : 0, draftRev: 3 }; },
    insertText(text, span) { calls.push('insert'); assert.equal(span.draftRev, 3); if (options.changed) return false; edits.push(text); return true; },
    persistDraft() { calls.push('persist'); },
  };
  const port = { async readTask(id: string) { calls.push('read'); assert.equal(id, target.task.id); return target; } };
  const sessions = {
    async list() { calls.push('list'); return options.bindings ?? []; },
    async bind(taskId: string, sessionId: string) { calls.push('bind'); bound.push([taskId, sessionId]); },
  };
  return { port, sessions, editor, calls, edits, bound, target };
}

test('official New Session binding inserts saved task prompt without sending or creating a Session', async () => {
  const f = fixture();
  const status = await bindNativeSessionTask(f.port, f.sessions, f.editor, 'native-session', f.target.task.id, '');
  assert.equal(status, 'inserted');
  assert.deepEqual(f.bound, [['task-1', 'native-session']]);
  assert.match(f.edits[0]!, /任务 ID：task-1/);
  assert.match(f.edits[0]!, /保存进展/);
  assert.deepEqual(f.calls, ['capture', 'list', 'read', 'bind', 'insert', 'persist']);
});

test('existing user draft is preserved with a separator and task prompt at its caret', async () => {
  const f = fixture();
  const status = await bindNativeSessionTask(f.port, f.sessions, f.editor, 'native-session', 'task-1', 'my notes');
  assert.equal(status, 'inserted');
  assert.ok(f.edits[0]?.startsWith('\n\n任务：'));
});

test('reopening a bound blank Session does not duplicate an injected prompt', async () => {
  const f = fixture({ bindings: [{ taskId: 'task-1', sessionId: 'native-session', createdAt: '' }] });
  const status = await bindNativeSessionTask(f.port, f.sessions, f.editor, 'native-session', 'task-1', '任务 ID：task-1\nnotes');
  assert.equal(status, 'already-present');
  assert.deepEqual(f.edits, []);
  assert.equal(f.calls.includes('insert'), false);
});

test('does not silently rebind a Session already owned by another task', async () => {
  const f = fixture({ bindings: [{ taskId: 'another', sessionId: 'native-session', createdAt: '' }] });
  await assert.rejects(bindNativeSessionTask(f.port, f.sessions, f.editor, 'native-session', 'task-1', ''), /已关联其他任务/);
  assert.deepEqual(f.bound, []);
  assert.deepEqual(f.edits, []);
});

test('concurrent edits prevent prompt injection but do not erase the bound Session', async () => {
  const f = fixture({ changed: true });
  assert.equal(await bindNativeSessionTask(f.port, f.sessions, f.editor, 'native-session', 'task-1', ''), 'draft-changed');
  assert.deepEqual(f.bound, [['task-1', 'native-session']]);
  assert.equal(f.calls.includes('persist'), false);
});

test('selected text is never replaced by a prompt', async () => {
  const f = fixture({ selected: true });
  assert.equal(await bindNativeSessionTask(f.port, f.sessions, f.editor, 'native-session', 'task-1', 'user selection'), 'draft-changed');
  assert.equal(f.calls.includes('insert'), false);
  assert.equal(f.bound.length, 1);
});
