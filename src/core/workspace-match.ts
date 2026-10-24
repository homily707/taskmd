/**
 * Pure Task → Workspace matching.
 *
 * A Task names a repository (`task.repo`); the per-machine registry maps that
 * name to a canonical directory. DSH owns a separate list of Workspaces, each
 * with its own canonical path. This module decides — without any I/O — whether
 * exactly one Workspace represents that repository, or whether the user has to
 * choose. It deliberately never guesses when the answer is ambiguous.
 */

/** The parts of a DSH Workspace the matcher reads. */
export interface WorkspaceLike {
  workspaceId: string;
  /** Canonical absolute host directory path, as the Host reports it. */
  path: string;
  /** User-visible title. */
  title: string;
}

/** A Task's repository reference: the registry name and its resolved path. */
export interface RepoInfo {
  /** `task.repo`; `null` when the Task has no repository. */
  name: string | null;
  /** Registry path for `name`; `null` when the mapping is missing. */
  directory: string | null;
}

export type WorkspaceMatch =
  | { kind: 'matched'; workspace: WorkspaceLike }
  | { kind: 'candidates'; list: WorkspaceLike[] }
  | { kind: 'none'; reason: 'no-repo' | 'no-workspaces' };

/** Trailing separators are cosmetic; they must not defeat an exact path match. */
function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

function baseName(path: string): string {
  const parts = normalizePath(path).split('/').filter(Boolean);
  return parts.at(-1) ?? '';
}

const sameName = (left: string, right: string) =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

/** The single Workspace a set of matches names, or the candidates to choose from. */
function resolve(list: WorkspaceLike[]): WorkspaceMatch {
  return list.length === 1 ? { kind: 'matched', workspace: list[0]! } : { kind: 'candidates', list };
}

/**
 * Resolves the Workspace for a Task's repository.
 *
 * Order: canonical path equality, then name equality (Workspace title, then
 * path basename), then every Workspace as a candidate. A Task without a
 * repository is never matched automatically, and an ambiguous hit is returned
 * as candidates rather than being resolved to the first entry.
 */
export function matchWorkspace(repo: RepoInfo, workspaces: readonly WorkspaceLike[]): WorkspaceMatch {
  if (!repo.name || !repo.name.trim()) return { kind: 'none', reason: 'no-repo' };
  if (workspaces.length === 0) return { kind: 'none', reason: 'no-workspaces' };
  const directory = repo.directory ? normalizePath(repo.directory) : '';
  if (directory) {
    const byPath = workspaces.filter(workspace => normalizePath(workspace.path) === directory);
    if (byPath.length > 0) return resolve(byPath);
  }
  const byTitle = workspaces.filter(workspace => sameName(workspace.title, repo.name!));
  if (byTitle.length > 0) return resolve(byTitle);
  const byBase = workspaces.filter(workspace => sameName(baseName(workspace.path), repo.name!));
  if (byBase.length > 0) return resolve(byBase);
  return { kind: 'candidates', list: [...workspaces] };
}
