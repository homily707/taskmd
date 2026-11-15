import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type { TypertRemoteCodecSpec, TypertRemoteMethodSpec, TypertRemoteParameterSpec } from '@deepseek-ai/dsh-typert-protocol';
import type { Attachment, CreateTaskInput, HomeSettings, State, TaskChanges, TaskRecord, TaskSessionBinding } from '../types.js';

export interface TaskmdChange { revision: string }
export interface TaskmdFileError { code: string; details?: unknown }
export interface TaskmdRemote {
  state(): Promise<State>;
  configure(settings: HomeSettings): Promise<State>;
  read(taskId: string): Promise<TaskRecord>;
  create(input: CreateTaskInput): Promise<TaskRecord>;
  update(taskId: string, changes: TaskChanges, expectedVersion: string): Promise<TaskRecord>;
  /** Not `remove`: DSH's generated Remote namespace service already defines that method. */
  removeTask(taskId: string, expectedVersion: string): Promise<void>;
  attachment(taskId: string, href: string): Promise<Attachment>;
  bindings(taskId?: string): Promise<TaskSessionBinding[]>;
  bind(taskId: string, sessionId: string): Promise<void>;
  unbind(taskId: string, sessionId: string): Promise<void>;
  touch(sessionId: string): Promise<boolean>;
  watch(signal: AbortSignal): AsyncIterable<TaskmdChange>;
}
export const settingsSchema = z.strictObject({ homeDirectory: z.string(), homeWorkspaceId: z.string().nullable(), tasksDirectory: z.string() });
export const changesSchema = z.strictObject({
  title: z.string().optional(), status: z.enum(['todo', 'in_progress', 'done', 'canceled']).optional(),
  parent: z.string().nullable().optional(), order: z.number().finite().optional(), archived: z.boolean().optional(), body: z.string().optional(),
});
export const createSchema = z.strictObject({ title: z.string(), parent: z.string().nullable().optional(), body: z.string().optional() });
const task = z.strictObject({ id: z.string(), title: z.string(), status: z.enum(['todo', 'in_progress', 'done', 'canceled']), parent: z.string().nullable(), order: z.number(), archived: z.boolean(), body: z.string() });
const record = z.strictObject({ task, content: z.string(), version: z.string(), path: z.string() });
const state = z.strictObject({ settings: settingsSchema, tasks: z.array(record), diagnostics: z.array(z.strictObject({ path: z.string(), message: z.string() })) });
const binding = z.strictObject({ taskId: z.string(), sessionId: z.string(), createdAt: z.string(), lastOpenedAt: z.string().optional() });
function codec(name: string, schema: z.ZodType): TypertRemoteCodecSpec { return { mode: 'strict', typeSymbol: `taskmd#${name}`, create: () => schema }; }
function parameter(name: string, schema: z.ZodType, optional = false): TypertRemoteParameterSpec {
  const value = codec(name, schema);
  return { name, source: 'json', codec: value, strictCodec: value, ...(optional ? { acceptsUndefined: true as const } : {}) };
}
function method(name: string, parameters: TypertRemoteParameterSpec[], result: z.ZodType): TypertRemoteMethodSpec {
  return { service: 'taskmd', invocation: { kind: 'direct' }, parameters, result: codec(`${name}:result`, result) };
}
const id = () => parameter('taskId', z.string());
const session = () => parameter('sessionId', z.string());
const version = () => parameter('expectedVersion', z.string());
export const TYPERT_REMOTE = createTypertRemoteInfo({
  package: 'taskmd', methods: {
    'taskmd/state': method('state', [], state),
    'taskmd/configure': method('configure', [parameter('settings', settingsSchema)], state),
    'taskmd/read': method('read', [id()], record),
    'taskmd/create': method('create', [parameter('input', createSchema)], record),
    'taskmd/update': method('update', [id(), parameter('changes', changesSchema), version()], record),
    'taskmd/removeTask': method('removeTask', [id(), version()], z.void()),
    'taskmd/attachment': method('attachment', [id(), parameter('href', z.string())], z.strictObject({ path: z.string(), mime: z.string(), dataUrl: z.string().optional(), content: z.string().optional() })),
    'taskmd/bindings': method('bindings', [parameter('taskId', z.string().optional(), true)], z.array(binding)),
    'taskmd/bind': method('bind', [id(), session()], z.void()),
    'taskmd/unbind': method('unbind', [id(), session()], z.void()),
    'taskmd/touch': method('touch', [session()], z.boolean()),
    'taskmd/watch': { ...method('watch', [], z.strictObject({ revision: z.string() })), mode: 'stream', cancellation: { parameter: 'signal' } },
  },
}, z);
