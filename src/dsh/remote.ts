import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import type {
  TypertRemoteCodecSpec, TypertRemoteMethodSpec, TypertRemoteParameterSpec,
} from '@deepseek-ai/dsh-typert-protocol';
import type {
  ApplyResult, Plan, State, TaskRecord, TaskSessionBinding, TaskSessionBindingFilter,
} from '../types.js';

export interface TaskmdAsset {
  content: string;
  path: string;
  version: string;
}

/** Every frame invalidates tasks, session bindings, and repository mappings. */
export interface TaskmdChange {
  revision: string;
}

export interface TaskmdStoreError {
  code: string;
  hint: string;
  details?: unknown;
}

/** Browser-safe business contract; DSH wraps calls in RemoteResult on the wire. */
export interface TaskmdRemote {
  state(): Promise<State>;
  read(taskId: string): Promise<TaskRecord>;
  apply(plan: Plan): Promise<ApplyResult>;
  asset(taskId: string, index: number): Promise<TaskmdAsset>;
  /** DSH clients pass `undefined` explicitly for an unfiltered call. */
  bindings(filter?: TaskSessionBindingFilter): Promise<TaskSessionBinding[]>;
  bind(taskId: string, sessionId: string): Promise<void>;
  unbind(taskId: string, sessionId: string): Promise<void>;
  /** Records an open of one bound Session; `false` when no binding matched. */
  touch(sessionId: string): Promise<boolean>;
  repositoryDirectory(taskId: string): Promise<string | null>;
  watch(signal: AbortSignal): AsyncIterable<TaskmdChange>;
}

const status = z.enum(['todo', 'in_progress', 'done', 'canceled']);
const assetRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('shared'), path: z.string(), share: z.enum(['task', 'root']) }),
  z.strictObject({ kind: z.literal('repo'), path: z.string(), repo: z.string(), share: z.enum(['task', 'root']) }),
]);
const task = z.strictObject({
  schema: z.literal(1), id: z.string(), title: z.string(), status,
  parent: z.string().nullable(), blocked_by: z.array(z.string()), order: z.string(),
  repo: z.string().nullable(), assets: z.array(assetRef), archived: z.boolean(), body: z.string(),
});
const reference = z.union([z.string(), z.strictObject({ key: z.string() })]);
const changes = z.strictObject({
  title: z.string().optional(), status: status.optional(), parent: reference.nullable().optional(),
  blocked_by: z.array(reference).optional(), order: z.string().optional(), repo: z.string().nullable().optional(),
  assets: z.array(assetRef).optional(), archived: z.boolean().optional(), body: z.string().optional(),
});
const plan = z.strictObject({
  requestId: z.string(), baseRevision: z.string(),
  operations: z.array(z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('create'), key: z.string().optional(), task: changes.extend({ title: z.string() }) }),
    z.strictObject({ op: z.literal('patch'), id: reference, changes, expectedVersion: z.string().optional() }),
    z.strictObject({ op: z.literal('replaceMarkdown'), id: reference, content: z.string(), expectedVersion: z.string() }),
    z.strictObject({ op: z.literal('archive'), id: reference }),
    z.strictObject({ op: z.literal('restore'), id: reference }),
    z.strictObject({ op: z.literal('delete'), id: reference, expectedVersion: z.string().optional() }),
  ])),
});
const state = z.strictObject({
  schemaVersion: z.literal(1), revision: z.string(), tasks: z.array(task), ready: z.array(z.string()),
  diagnostics: z.array(z.strictObject({
    code: z.string(), message: z.string(), severity: z.enum(['error', 'warning']), taskId: z.string().optional(),
  })),
});
const binding = z.strictObject({
  taskId: z.string(), provider: z.string(), instanceId: z.string(),
  sessionId: z.string(), createdAt: z.string(), lastOpenedAt: z.string().optional(),
});

function codec(name: string, schema: z.ZodType): TypertRemoteCodecSpec {
  return { mode: 'strict', typeSymbol: `taskmd#${name}`, create: () => schema };
}
function parameter(name: string, schema: z.ZodType, optional = false): TypertRemoteParameterSpec {
  const value = codec(name, schema);
  return {
    name, source: 'json', codec: value, strictCodec: value,
    ...(optional ? { acceptsUndefined: true as const } : {}),
  };
}
function method(name: string, parameters: TypertRemoteParameterSpec[], result: z.ZodType): TypertRemoteMethodSpec {
  return {
    service: 'taskmd', invocation: { kind: 'direct' }, parameters,
    result: codec(`${name}:result`, result),
  };
}
const taskId = () => parameter('taskId', z.string());
const sessionId = () => parameter('sessionId', z.string());

/** Mount before calling ctx.remote.taskmd; this module has no Node or Host imports. */
export const TYPERT_REMOTE = createTypertRemoteInfo({
  package: 'taskmd',
  methods: {
    'taskmd/state': method('state', [], state),
    'taskmd/read': method('read', [taskId()], z.strictObject({ task, content: z.string(), version: z.string() })),
    'taskmd/apply': method('apply', [parameter('plan', plan)], z.strictObject({
      schemaVersion: z.literal(1), requestId: z.string(), revision: z.string(),
      ids: z.record(z.string(), z.string()), versions: z.record(z.string(), z.string()),
    })),
    'taskmd/asset': method('asset', [taskId(), parameter('index', z.number().int().nonnegative())], z.strictObject({
      content: z.string(), path: z.string(), version: z.string(),
    })),
    'taskmd/bindings': method('bindings', [parameter('filter', z.strictObject({
      taskId: z.string().optional(), provider: z.string().optional(),
      instanceId: z.string().optional(), sessionId: z.string().optional(),
    }).optional(), true)], z.array(binding)),
    'taskmd/bind': method('bind', [taskId(), sessionId()], z.void()),
    'taskmd/unbind': method('unbind', [taskId(), sessionId()], z.void()),
    // The Host decorator scopes this call to the Session resource too, since the
    // row is found by Session identity rather than by Task.
    'taskmd/touch': method('touch', [sessionId()], z.boolean()),
    'taskmd/repositoryDirectory': method('repositoryDirectory', [taskId()], z.string().nullable()),
    'taskmd/watch': {
      ...method('watch', [], z.strictObject({ revision: z.string() })),
      mode: 'stream', cancellation: { parameter: 'signal' },
    },
  },
}, z);
