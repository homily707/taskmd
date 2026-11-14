import type { Diagnostic, TaskMetadata } from '../types.js';

function childIndex(tasks: TaskMetadata[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parent === null) continue;
    const siblings = children.get(task.parent) ?? [];
    siblings.push(task.id);
    children.set(task.parent, siblings);
  }
  return children;
}

export function descendants(tasks: TaskMetadata[], id: string): string[] {
  const children = childIndex(tasks);
  const seen = new Set([id]);
  const result: string[] = [];
  const pending = [...(children.get(id) ?? [])].reverse();
  while (pending.length) {
    const child = pending.pop()!;
    if (seen.has(child)) continue;
    seen.add(child);
    result.push(child);
    const nested = children.get(child) ?? [];
    for (let index = nested.length - 1; index >= 0; index--) pending.push(nested[index]!);
  }
  return result;
}

export interface ExecutionBlocker {
  /** The task declaring the dependency, or the ancestor preventing execution. */
  taskId: string;
  dependencyId?: string;
  message: string;
}

/**
 * Walks the parent chain once and explains why `id` may not be executed.
 *
 * Nothing is copied into State: the direct dependencies of the task and of each
 * ancestor are read on demand, which is what keeps a single source of truth.
 */
function blockersFor(byId: Map<string, TaskMetadata>, id: string): ExecutionBlocker[] {
  const result: ExecutionBlocker[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const task = byId.get(current);
    if (!task) break;
    // Dependencies are informative references, not execution prerequisites.
    for (const dependencyId of task.blocked_by) {
      const dependency = byId.get(dependencyId);
      if (dependency?.status !== 'done') result.push({
        taskId: current, dependencyId,
        message: `${task.title} 关联的「${dependency?.title ?? dependencyId}」尚未完成（仅供参考）。`,
      });
    }
    current = task.parent;
  }
  return result;
}

/** Explain execution prerequisites on demand without copying inherited dependencies into State. */
export function executionBlockers(tasks: TaskMetadata[], id: string): ExecutionBlocker[] {
  return blockersFor(new Map(tasks.map(task => [task.id, task])), id);
}

/** Single-task deletion never removes dependency edges or descendants implicitly. */
export function deletionBlockers(tasks: TaskMetadata[], task: TaskMetadata): Diagnostic[] {
  // Deletion must not orphan children. Status and informational references
  // never prevent deleting a document.
  const children = tasks.filter(item => item.parent === task.id);
  return children.length ? [{
    code: 'delete_has_children',
    message: `请先移动或删除子任务：${children.map(item => item.title).join('、')}。`,
    taskId: task.id, severity: 'error',
  }] : [];
}

/**
 * The outline is a collection of editable Markdown documents. Only malformed
 * hierarchy is an error. Legacy blocked_by links are advisory and may cross
 * parents or point at deleted tasks without preventing ordinary edits.
 */
export function analyze(tasks: TaskMetadata[]): { diagnostics: Diagnostic[]; ready: string[] } {
  const diagnostics: Diagnostic[] = [];
  const byId = new Map<string, TaskMetadata>();
  const report = (code: string, message: string, taskId: string, severity: Diagnostic['severity'] = 'error') =>
    diagnostics.push({ code, message, taskId, severity });

  for (const task of tasks) {
    if (byId.has(task.id)) report('DUPLICATE_ID', `Duplicate task ID: ${task.id}`, task.id);
    else byId.set(task.id, task);
  }
  for (const task of tasks) {
    if (task.parent && !byId.has(task.parent)) report('MISSING_PARENT', `Parent ${task.parent} does not exist.`, task.id);
    if (task.parent === task.id) report('SELF_PARENT', 'A document cannot be its own parent.', task.id);
    for (const id of task.blocked_by) {
      if (id === task.id) report('SELF_DEPENDENCY', 'A task references itself.', task.id, 'warning');
      else if (!byId.has(id)) report('MISSING_DEPENDENCY', `Referenced task ${id} does not exist.`, task.id, 'warning');
    }
  }
  // Parent cycles would make the Markdown outline impossible to navigate.
  const verified = new Set<string>();
  for (const task of tasks) {
    const chain = new Set<string>();
    let current: TaskMetadata | undefined = task;
    while (current && !verified.has(current.id)) {
      if (chain.has(current.id)) {
        report('PARENT_CYCLE', `Parent hierarchy has a cycle at ${current.id}.`, current.id);
        break;
      }
      chain.add(current.id);
      current = current.parent ? byId.get(current.parent) : undefined;
    }
    for (const id of chain) verified.add(id);
  }
  // Keep the existing ready array for callers, but it is now a simple
  // unarchived-todo filter, not an execution permission check.
  const ready = tasks.filter(task => !task.archived && task.status === 'todo')
    .sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.id.localeCompare(b.id))
    .map(task => task.id);
  return { diagnostics, ready };
}
