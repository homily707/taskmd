import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSessionReachable, type SessionReachabilityScope } from '../src/adapters/session-nav.js';
import { TaskError } from '../src/types.js';

/**
 * Builds the injection-free `get` the adapter uses, with only the services a
 * case cares about. Absent services must read as "cannot tell", never as
 * "unreachable".
 */
function scopeOf(services: Record<string, unknown>): SessionReachabilityScope {
  return { get: (name: string) => services[name] };
}

function archived(...sessionIds: string[]) {
  return { list: { getSnapshot: () => ({ archivedSessionIds: sessionIds }) } };
}

function catalog(phase: string, ...sessionIds: string[]) {
  return { list: { getSnapshot: () => ({ phase, byId: Object.fromEntries(sessionIds.map((id) => [id, {}])) }) } };
}

function access(allowed: boolean) {
  return { source: () => ({ getSnapshot: () => allowed }) };
}

function rejectsWithCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof TaskError, `expected a TaskError, got ${String(error)}`);
    assert.equal(error.code, code);
    // Every failure must tell the user what to do next.
    assert.ok(error.hint.length > 0, 'the error carries a recovery hint');
    return true;
  };
}

test('a reachable Session passes every check', () => {
  const scope = scopeOf({
    workspaces: archived('other-session'),
    remoteAccess: access(true),
    sessions: catalog('ready', 'session-1', 'other-session'),
  });
  assert.doesNotThrow(() => assertSessionReachable(scope, 'session-1'));
});

test('an archived Session is refused with session_archived', () => {
  const scope = scopeOf({ workspaces: archived('session-1'), sessions: catalog('ready', 'session-1') });
  assert.throws(() => assertSessionReachable(scope, 'session-1'), rejectsWithCode('session_archived'));
});

test('the archive check runs before the access check', () => {
  // An archived Session the peer cannot read is still reported as archived: that
  // is the actionable fact, and it avoids leaking the access answer.
  const scope = scopeOf({
    workspaces: archived('session-1'),
    remoteAccess: access(false),
    sessions: catalog('ready', 'session-1'),
  });
  assert.throws(() => assertSessionReachable(scope, 'session-1'), rejectsWithCode('session_archived'));
});

test('a denied peer is refused with session_forbidden', () => {
  // The Host filters `session.list` by access, so the row is absent here too —
  // the access answer must still win, because "forbidden" is not "deleted".
  const scope = scopeOf({ remoteAccess: access(false), sessions: catalog('ready') });
  assert.throws(() => assertSessionReachable(scope, 'session-1'), rejectsWithCode('session_forbidden'));
});

test('a Session missing from a ready catalog is refused with session_not_found', () => {
  const scope = scopeOf({ remoteAccess: access(true), sessions: catalog('ready', 'other-session') });
  assert.throws(() => assertSessionReachable(scope, 'session-1'), rejectsWithCode('session_not_found'));
});

test('a pending catalog never claims a Session is missing', () => {
  // The first list pull has not arrived; an absent row proves nothing yet.
  const scope = scopeOf({ remoteAccess: access(true), sessions: catalog('pending') });
  assert.doesNotThrow(() => assertSessionReachable(scope, 'session-1'));
});

test('an empty catalog without a workspace service still defers while pending', () => {
  const scope = scopeOf({ sessions: catalog('pending') });
  assert.doesNotThrow(() => assertSessionReachable(scope, 'session-1'));
});

test('missing services degrade to cannot-tell rather than refusing', () => {
  // A Client that mounts none of these still opens: navigation degrades to the
  // plain `openSession` call instead of blocking every binding.
  assert.doesNotThrow(() => assertSessionReachable(scopeOf({}), 'session-1'));
  // The access source alone can be missing while the catalog is authoritative.
  const partial = scopeOf({ sessions: catalog('ready', 'session-1') });
  assert.doesNotThrow(() => assertSessionReachable(partial, 'session-1'));
});
