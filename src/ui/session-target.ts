/**
 * Pure decisions for creating a Task Session.
 *
 * `session.create` accepts `workspaceId` and `cwd` as alternatives — passing
 * both is a `gateway/bad-request` — so the choice is made once, here, and
 * tested independently of React.
 */

import type { WorkspaceMatch } from '../core/workspace-match.js';
import type { SessionCapability, WorkspaceSummary } from './port.js';

/** Exactly one `session.create` target. */
export type Target =
  | { kind: 'workspace'; workspaceId: string; label: string }
  | { kind: 'directory'; cwd: string; label: string };

export type CreateOptions = Parameters<SessionCapability['create']>[1];

export interface TargetInput {
  /** A path the user typed; it overrides every automatic choice. */
  manual: string;
  /** A Workspace the user picked from the candidate list. */
  chosen: string;
  match: WorkspaceMatch | undefined;
  workspaces: readonly WorkspaceSummary[] | undefined;
  directory: string | null | undefined;
}

/**
 * Picks the single creation target from the user's choice and the matcher.
 *
 * Precedence: a typed directory, then the picked Workspace, then an automatic
 * match, then the Task's repository directory. The repository path is the last
 * resort because a Client without a Workspace service can still create a
 * Session — it just cannot satisfy `workspaceId`.
 */
export function resolveTarget(input: TargetInput): Target | undefined {
  const manual = input.manual.trim();
  if (manual) return { kind: 'directory', cwd: manual, label: manual };
  const auto = input.match?.kind === 'matched' ? input.match.workspace : undefined;
  const workspaceId = input.chosen || auto?.workspaceId;
  if (workspaceId) {
    const workspace = input.workspaces?.find(item => item.workspaceId === workspaceId);
    return {
      kind: 'workspace',
      workspaceId,
      label: workspace ? `${workspace.title}（${workspace.path}）` : workspaceId,
    };
  }
  if (input.directory) return { kind: 'directory', cwd: input.directory, label: input.directory };
  return undefined;
}

/**
 * Builds options for SessionCapability.create. The adapter translates
 * `directory` into the Host's `cwd`; a workspace target omits it.
 */
export function createOptions(target: Target, agentPreset?: string): CreateOptions {
  const preset = agentPreset?.trim();
  const shared = preset ? { agentPreset: preset } : {};
  return target.kind === 'workspace'
    ? { workspaceId: target.workspaceId, ...shared }
    : { directory: target.cwd, ...shared };
}

/** A creation or binding failure, flattened for display and for the retry UI. */
export interface Failure {
  message: string;
  /** Stable Host/store code, when the failure carries one. */
  code?: string;
  /** The Session that already exists; the user can rebind instead of recreating. */
  sessionId?: string;
  /** For `session_already_bound`: the Task that currently owns the Session. */
  existingTaskId?: string;
}

function readDetails(error: unknown): Record<string, unknown> {
  const details = (error as { details?: unknown } | null)?.details;
  return details && typeof details === 'object' ? details as Record<string, unknown> : {};
}

function readString(details: Record<string, unknown>, key: string): string | undefined {
  const value = details[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Flattens anything thrown by the capability into a {@link Failure}.
 *
 * The Task store reports `session_already_bound` as the error's own code with
 * `existingTaskId` in its details; a created-but-unbound Session reports
 * `session_bind_failed` with its `sessionId`. Both survive here so the UI can
 * offer rebinding instead of dropping a live Session.
 */
export function describeFailure(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code
    : undefined;
  const details = readDetails(error);
  const sessionId = readString(details, 'sessionId');
  const existingTaskId = readString(details, 'existingTaskId');
  return {
    message,
    ...(code ? { code } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(existingTaskId ? { existingTaskId } : {}),
  };
}
