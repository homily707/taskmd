import { TaskError } from '../types.js';

/**
 * The Client services that decide whether a Session can be shown.
 *
 * Narrow structural faces of the shipped DSH Client APIs, so this module stays
 * free of React, the snapshot store, and every other browser-only dependency.
 * A missing service degrades to "cannot tell" rather than "unreachable".
 */
export interface SessionReachabilityScope {
  /** Injection-free service read. */
  get(name: string): unknown;
}

/** `workspaces.list`: the archive set is global, not per Workspace. */
interface WorkspaceService {
  list: { getSnapshot(): { archivedSessionIds: readonly string[] } };
}

/** `sessions.list`: enough to tell "gone" from "still loading". */
interface SessionCatalogService {
  list: { getSnapshot(): { phase: string; byId: Record<string, unknown> } };
}

/** `remoteAccess.source(kind, id, action)`: one identity-stable boolean source. */
interface RemoteAccessService {
  source(kind: string, id: string, action: string): { getSnapshot(): boolean };
}

/**
 * The action that proves a peer may read one Session.
 *
 * `openSession` retains the Session for the main view, which mounts its
 * `session/follow` stream; a peer without that grant cannot present it.
 */
const SESSION_READ_ACTION = 'session/follow';

/**
 * Rejects a Session the layout cannot present, before navigation is attempted.
 *
 * `uiWorkspace.openSession` accepts any string and reports nothing back, so
 * without this check an archived, deleted, or unauthorized Session looks like a
 * successful jump to an empty conversation. Two rules keep the answer honest:
 *
 * - The Host filters `session.list` by access, so an absent row cannot tell
 *   "deleted" from "forbidden". Access is therefore asked first, and only a
 *   **ready** catalog — its first list pull has arrived — may claim absence.
 * - Nothing here writes. Every failure leaves the Task, its status, and the
 *   binding untouched, so the user can retry or unbind deliberately.
 *
 * @throws {TaskError} `session_archived`, `session_forbidden`, or
 *   `session_not_found`, each with a hint naming the next step.
 */
export function assertSessionReachable(scope: SessionReachabilityScope, sessionId: string): void {
  const archived = (scope.get('workspaces') as WorkspaceService | undefined)
    ?.list.getSnapshot().archivedSessionIds;
  if (archived?.includes(sessionId)) {
    throw new TaskError(
      'session_archived',
      `会话 ${sessionId} 已归档，DSH 不允许直接打开归档会话。`,
      '先在 DSH 侧栏恢复这个会话再打开；任务与绑定都没有改动。',
    );
  }
  const allowed = (scope.get('remoteAccess') as RemoteAccessService | undefined)
    ?.source('session', sessionId, SESSION_READ_ACTION).getSnapshot();
  if (allowed === false) {
    throw new TaskError(
      'session_forbidden',
      `当前连接没有访问会话 ${sessionId} 的权限。`,
      '这个会话可能属于别的机器或账户；建议解除关联后改绑可访问的会话。任务与绑定都没有改动。',
    );
  }
  const catalog = (scope.get('sessions') as SessionCatalogService | undefined)?.list.getSnapshot();
  if (catalog?.phase === 'ready' && catalog.byId[sessionId] === undefined) {
    throw new TaskError(
      'session_not_found',
      `会话 ${sessionId} 不存在：DSH 的会话列表里没有它，可能已被删除。`,
      '建议解除这条关联，避免任务指向一个打不开的会话。任务数据没有被改动。',
    );
  }
}
