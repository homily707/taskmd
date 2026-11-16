export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'canceled';

export interface Task {
  id: string;
  title: string;
  /** One-line digest shown in task lists; written by the Agent. */
  summary?: string;
  status: TaskStatus;
  parent: string | null;
  order: number;
  archived: boolean;
  body: string;
}

export interface TaskRecord {
  task: Task;
  content: string;
  version: string;
  path: string;
}

export interface HomeSettings {
  homeDirectory: string;
  homeWorkspaceId: string | null;
  /** A relative directory under Home. Defaults to tasks. */
  tasksDirectory: string;
}

export interface Diagnostic { path: string; message: string }
export interface InboxEntry {
  name: string;
  path: string;
  content: string;
  version: string;
  task: Task;
  /** Missing fields are filled with generated values when the file is imported. */
  materialize: boolean;
  /** The order was omitted and is assigned among its siblings on import. */
  autoOrder: boolean;
}
export interface InboxState {
  directory: string;
  pending: number;
  diagnostics: Diagnostic[];
}
export interface State { settings: HomeSettings; tasks: TaskRecord[]; diagnostics: Diagnostic[]; inbox: InboxState }
export interface CreateTaskInput { title: string; parent?: string | null; body?: string; summary?: string }
export type TaskChanges = Partial<Omit<Task, 'id'>>;

export interface TaskSessionBinding {
  taskId: string;
  sessionId: string;
  createdAt: string;
  lastOpenedAt?: string;
}

export interface Attachment {
  path: string;
  mime: string;
  /** Safe image data URL, or UTF-8 text for supported text attachments. */
  dataUrl?: string;
  content?: string;
}

export class TaskError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'TaskError';
  }
}
