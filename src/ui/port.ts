import type { Attachment, CreateTaskInput, HomeSettings, State, TaskChanges, TaskRecord, TaskSessionBinding } from '../types.js';

export interface TaskPort {
  getState(signal?: AbortSignal): Promise<State>;
  configure(settings: HomeSettings): Promise<State>;
  readTask(id: string, signal?: AbortSignal): Promise<TaskRecord>;
  createTask(input: CreateTaskInput): Promise<TaskRecord>;
  updateTask(id: string, changes: TaskChanges, expectedVersion: string): Promise<TaskRecord>;
  deleteTask(id: string, expectedVersion: string): Promise<string[]>;
  readAttachment(id: string, href: string): Promise<Attachment>;
  subscribe(listener: () => void): () => void;
}

export interface PresetOption {
  id: string;
  name?: string;
  description?: string;
  isDefault?: boolean;
}
export interface WorkspaceSummary { workspaceId: string; path: string; title: string }
export interface ModelEffort { id: string; name: string; description?: string }
export interface ModelOption {
  id: string; name: string; description?: string;
  reasoning?: { efforts: ModelEffort[]; defaultEffort?: string };
}
export interface ModelGroup { id: string; name: string; models: ModelOption[] }
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface ModelCatalog {
  default: ModelSelection;
  routableProviders: string[];
  groups: ModelGroup[];
  failures: { id: string; name: string; message: string }[];
}
export interface SessionStatus {
  sessionId: string;
  pending?: 'approval' | 'plan-review' | 'question';
  running: boolean;
  fresh?: boolean;
  blank?: boolean;
  archived?: boolean;
  missing?: boolean;
  title?: string;
  agentPreset?: string;
  tokens?: number;
  runningSubagents?: number;
  updatedAt?: number;
}
export interface SessionStatusSource {
  get(): Map<string, SessionStatus>;
  subscribe(listener: () => void): () => void;
}
export interface SessionCapability {
  list(taskId?: string, signal?: AbortSignal): Promise<TaskSessionBinding[]>;
  statuses?(): SessionStatusSource;
  title?(sessionId: string): string | undefined;
  open(sessionId: string): Promise<void>;
  create(taskId: string, options: { workspaceId?: string; directory?: string; agentPreset?: string }): Promise<{ sessionId: string }>;
  bind(taskId: string, sessionId: string): Promise<void>;
  unbind(taskId: string, sessionId: string): Promise<void>;
  currentDirectory?(signal?: AbortSignal): Promise<string | null>;
  subscribeTargets?(listener: () => void): () => void;
  workspaces(signal?: AbortSignal): Promise<WorkspaceSummary[]>;
  presets?(signal?: AbortSignal): Promise<PresetOption[]>;
  catalog?(signal?: AbortSignal): Promise<ModelCatalog>;
  selectModel?(sessionId: string, selection: ModelSelection): Promise<void>;
  send?(sessionId: string, text: string, requestId: string): Promise<void>;
}
