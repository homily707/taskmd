import type { ApplyResult, Plan, State, TaskRecord, TaskSessionBinding } from '../types.js';

export interface TaskGraphPort {
  getState(signal?: AbortSignal): Promise<State>;
  readTask(id: string, signal?: AbortSignal): Promise<TaskRecord>;
  apply(plan: Plan, signal?: AbortSignal): Promise<ApplyResult>;
  readAsset(id: string, index: number, signal?: AbortSignal): Promise<{ content: string; path: string; version: string }>;
  subscribe(listener: () => void): () => void;
}

/** One DSH Workspace as the Client exposes it: identity, canonical path, title. */
export interface WorkspaceSummary {
  workspaceId: string;
  path: string;
  title: string;
}

export interface ModelEffort {
  id: string;
  name: string;
  description?: string;
}

/** One provider-owned model with its adapter-declared reasoning efforts. */
export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  reasoning?: { efforts: ModelEffort[]; defaultEffort?: string };
}

export interface ModelGroup {
  id: string;
  name: string;
  models: ModelOption[];
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface ModelCatalog {
  default: ModelSelection;
  routableProviders: string[];
  groups: ModelGroup[];
  failures: { id: string; name: string; message: string }[];
}

/**
 * DSH-side Session operations. The standalone Web UI has no Session service at
 * all, so every member beyond the binding surface is optional and the UI must
 * degrade when one is missing.
 */
export interface SessionCapability {
  list(taskId?: string, signal?: AbortSignal): Promise<TaskSessionBinding[]>;
  open(sessionId: string): Promise<void>;
  /**
   * Creates a blank Session at a Workspace or directory (never both) and binds
   * it to the Task. The Host entity exists before the first message.
   */
  create(taskId: string, options: { workspaceId?: string; directory?: string; agentPreset?: string }): Promise<{ sessionId: string }>;
  bind(taskId: string, sessionId: string): Promise<void>;
  unbind(taskId: string, sessionId: string): Promise<void>;
  /** The Task's repository directory; `null` when it has no repo or no mapping. */
  directory?(taskId: string, signal?: AbortSignal): Promise<string | null>;
  /** Workspaces known to this Client; empty when the Client has no Workspace service. */
  workspaces?(signal?: AbortSignal): Promise<WorkspaceSummary[]>;
  /** Host model catalog used to choose a model for a freshly created Session. */
  catalog?(signal?: AbortSignal): Promise<ModelCatalog>;
  /** Applies a model to one Session; the Host also persists it as the default. */
  selectModel?(sessionId: string, selection: ModelSelection): Promise<void>;
  /** Sends one prompt; retries must reuse the request id and exact text. */
  send?(sessionId: string, text: string, requestId: string): Promise<void>;
}
