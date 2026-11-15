import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-agent';
import type { TaskmdRemote } from './remote.js';

/** The same operations as the UI; no CLI or second task protocol. */
export function taskTool(api: Omit<TaskmdRemote, 'watch'>) {
  return defineTool({
    name: 'taskmd',
    description: 'Organize Home tasks and their DSH conversation links. Create tasks through this tool; then read or edit the returned Markdown path normally. Task status is manual and independent of Agent activity. list returns summaries; read returns the full task and version.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'read', 'create', 'update', 'delete', 'configure', 'bindings', 'bind', 'unbind', 'attachment'] },
      taskId: { type: 'string', description: 'Task ID for read, update, delete, bind, unbind or attachment.' },
      title: { type: 'string', description: 'Title of a new task.' },
      body: { type: 'string', description: 'Markdown body of a new task.' },
      parent: { type: 'string', description: 'Optional parent ID when creating a task.' },
      changes: { type: 'object', additionalProperties: false, description: 'Fields to update; only explicit changes are applied.', properties: {
        title: { type: 'string' }, body: { type: 'string' }, status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'canceled'] },
        parent: { oneOf: [{ type: 'string' }, { type: 'null' }] }, order: { type: 'number' }, archived: { type: 'boolean' },
      } },
      expectedVersion: { type: 'string', description: 'Version from read, required for update or delete. Reread and merge after a conflict. Delete removes the task and its whole subtree.' },
      sessionId: { type: 'string', description: 'DSH Session ID to bind or unbind. Does not create or send a message.' },
      homeDirectory: { type: 'string', description: 'Existing absolute Home path for configure.' },
      homeWorkspaceId: { type: 'string', description: 'DSH Workspace ID of Home for configure.' },
      tasksDirectory: { type: 'string', description: 'Relative tasks directory within Home; defaults to tasks.' },
      href: { type: 'string', description: 'Attachment link relative to a task Markdown file.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const required = (value: string | undefined, name: string): string => {
        if (!value?.trim()) throw new Error(`${name} is required for ${args.action}`);
        return value;
      };
      let value: unknown;
      switch (args.action) {
        case 'list': {
          const state = await api.state();
          value = { ...state, tasks: state.tasks.map(({ task, path, version }) => ({ ...task, body: undefined, path, version })) };
          break;
        }
        case 'read': value = await api.read(required(args.taskId, 'taskId')); break;
        case 'create': value = await api.create({ title: required(args.title, 'title'), body: args.body, parent: args.parent }); break;
        case 'update': value = await api.update(required(args.taskId, 'taskId'), args.changes ?? {}, required(args.expectedVersion, 'expectedVersion')); break;
        case 'delete': value = { deleted: await api.removeTask(required(args.taskId, 'taskId'), required(args.expectedVersion, 'expectedVersion')) }; break;
        case 'configure': {
          const state = await api.configure({ homeDirectory: required(args.homeDirectory, 'homeDirectory'), homeWorkspaceId: args.homeWorkspaceId ?? null, tasksDirectory: args.tasksDirectory ?? 'tasks' });
          value = { settings: state.settings, taskCount: state.tasks.length, diagnostics: state.diagnostics };
          break;
        }
        case 'bindings': value = await api.bindings(args.taskId); break;
        case 'bind': await api.bind(required(args.taskId, 'taskId'), required(args.sessionId, 'sessionId')); value = { bound: true }; break;
        case 'unbind': await api.unbind(required(args.taskId, 'taskId'), required(args.sessionId, 'sessionId')); value = { unbound: true }; break;
        case 'attachment': value = await api.attachment(required(args.taskId, 'taskId'), required(args.href, 'href')); break;
        default: throw new Error('Unknown taskmd action');
      }
      return JSON.parse(JSON.stringify(value));
    },
  });
}

export function registerTaskTools(ctx: Context, api: TaskmdRemote): void {
  // Tools live in each Agent's context. Both Agent disposal and plugin unload
  // own these registrations, including agents that predate plugin activation.
  ctx.inject(['agents', 'tools'], scope => {
    const registrations = new Map<string, () => void>();
    const attach = (agent: ReturnType<typeof scope.agents.list>[number]) => {
      if (registrations.has(agent.id)) return;
      const dispose = scope.effect(() => agent.ctx.effect(() => agent.ctx.tools.register(taskTool(api)), 'taskmd: Agent tool'), 'taskmd: owned Agent tool');
      registrations.set(agent.id, dispose);
    };
    scope.on('agent/created', ({ agent }) => { attach(agent); return undefined; });
    scope.on('agent/disposed', ({ agent }) => { registrations.get(agent.id)?.(); registrations.delete(agent.id); });
    for (const agent of scope.agents.list()) attach(agent);
    return () => { for (const dispose of registrations.values()) dispose(); registrations.clear(); };
  });
}
