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

export type TemplateKind = 'initial' | 'review' | 'task';
export interface TemplateFile { path: string; content: string }

export interface HomeSettings {
  homeDirectory: string;
  homeWorkspaceId: string | null;
  /** A relative directory under Home. Defaults to tasks. */
  tasksDirectory: string;
}

export interface Diagnostic { path: string; message: string }

/** One model selection accepted by a JSON Session request. */
export interface SessionInboxModel { provider: string; model: string; reasoningEffort?: string }
/**
 * A JSON file dropped into the inbox that creates exactly one Session. It maps
 * to the same fields as the normal "new Session" flow: location, preset, model
 * and an optional first prompt, plus an optional Task to bind after creation.
 */
export interface SessionInboxRequest {
  version: 1;
  workspaceId?: string;
  cwd?: string;
  agentPreset?: string;
  model?: SessionInboxModel;
  taskId?: string;
  prompt?: string;
}
export interface SessionInboxEntry { name: string; path: string; content: string; version: string; request: SessionInboxRequest }
/** The durable outcome written next to a processed request file. */
export interface SessionInboxResult {
  version: 1;
  source: string;
  status: 'done' | 'failed' | 'unknown';
  sessionId?: string;
  applied: { created: boolean; model: boolean; bound: boolean; prompted: boolean };
  error?: { code: string; message: string };
  startedAt: string;
  finishedAt: string;
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
