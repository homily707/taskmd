export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'canceled';

export type AssetRef =
  | { kind: 'shared'; path: string; repo?: never; share: 'task' | 'root' }
  | { kind: 'repo'; path: string; repo: string; share: 'task' | 'root' };

export interface Task {
  schema: 1;
  id: string;
  title: string;
  status: TaskStatus;
  parent: string | null;
  blocked_by: string[];
  order: string;
  repo: string | null;
  assets: AssetRef[];
  archived: boolean;
  body: string;
}

export type TaskMetadata = Omit<Task, 'body'>;

/**
 * A Task's external execution link (Execution Binding).
 *
 * A Session is identified by `(provider, instanceId, sessionId)`; `taskId` and
 * the timestamps are attributes of the link, not part of the identity. Bindings
 * live only in the per-machine `sessions.json` and never touch task Markdown.
 */
export interface TaskSessionBinding {
  taskId: string;
  /** Execution provider; this release writes only `'dsh'`. */
  provider: string;
  /** Stable per-machine provider instance identifier (see `instance.json`). */
  instanceId: string;
  sessionId: string;
  createdAt: string;
  /** Last time a client opened this Session for the Task, when known. */
  lastOpenedAt?: string;
}

export interface TaskSessionBindingFilter {
  taskId?: string;
  provider?: string;
  instanceId?: string;
  sessionId?: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  taskId?: string;
}

export interface TaskRecord {
  task: Task;
  content: string;
  version: string;
}

export interface State {
  schemaVersion: 1;
  revision: string;
  tasks: Task[];
  diagnostics: Diagnostic[];
  ready: string[];
}

export type MetadataState = Omit<State, 'tasks'> & { tasks: TaskMetadata[] };

export type Ref = string | { key: string };

export type CreateTaskInput = Partial<Omit<Task, 'schema' | 'id' | 'title' | 'parent' | 'blocked_by'>> & {
  title: string;
  parent?: Ref | null;
  blocked_by?: Ref[];
};

export type TaskChanges = Partial<Omit<Task, 'schema' | 'id' | 'parent' | 'blocked_by'>> & {
  parent?: Ref | null;
  blocked_by?: Ref[];
};

export type Operation =
  | { op: 'create'; key?: string; task: CreateTaskInput }
  | { op: 'patch'; id: Ref; changes: TaskChanges; expectedVersion?: string }
  | { op: 'replaceMarkdown'; id: Ref; content: string; expectedVersion: string }
  | { op: 'archive'; id: Ref }
  | { op: 'restore'; id: Ref }
  | { op: 'delete'; id: Ref; expectedVersion?: string };

export interface Plan {
  requestId: string;
  baseRevision: string;
  operations: Operation[];
}

export interface ApplyResult {
  schemaVersion: 1;
  requestId: string;
  revision: string;
  ids: Record<string, string>;
  versions: Record<string, string>;
}

export class TaskError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly details?: unknown;

  constructor(code: string, message: string, hint: string = '', details?: unknown) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}
