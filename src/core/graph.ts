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
  const origin = byId.get(id);
  const seen = new Set<string>();
  let current: string | null = id;
  while (current !== null) {
    if (seen.has(current)) {
      result.push({ taskId: current, message: `Parent chain contains a cycle at ${current}.` });
      break;
    }
    seen.add(current);
    const task = byId.get(current);
    if (!task) {
      result.push({ taskId: current, message: `Task ${current} does not exist.` });
      break;
    }
    const label = current === id ? `Task ${task.title} (${current})` : `Ancestor ${task.title} (${current})`;
    // Completed work stays valid inside a canceled or archived subtree, so a
    // finished task is never told to reopen anything.
    if (origin?.status !== 'done' && origin?.status !== 'canceled') {
      if (task.archived) result.push({ taskId: current, message: `${label} is archived; restore it before starting work.` });
      else if (task.status === 'canceled') result.push({ taskId: current, message: `${label} is canceled; reopen it explicitly before starting work.` });
      else if (current !== id && task.status === 'done') result.push({ taskId: current, message: `${label} is done; reopen it explicitly before starting work.` });
    }
    for (const dependencyId of task.blocked_by) {
      const dependency = byId.get(dependencyId);
      if (dependency?.status !== 'done') {
        result.push({ taskId: current, dependencyId, message: `${label} is waiting for ${dependency?.title ?? dependencyId} (${dependencyId}) to be done.` });
      }
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
  const blockers: Diagnostic[] = [];
  const add = (code: string, message: string) => blockers.push({ code, message, taskId: task.id, severity: 'error' });
  if (task.status !== 'canceled' && !task.archived) add('delete_requires_terminal', '请先取消或归档该任务。');
  if (task.blocked_by.length) add('delete_has_dependencies', '请先移除该任务的全部直接依赖。');
  const dependents = tasks.filter(item => item.blocked_by.includes(task.id));
  if (dependents.length) add('delete_has_dependents', `请先解除这些任务对它的依赖：${dependents.map(item => item.title).join('、')}。`);
  const children = tasks.filter(item => item.parent === task.id);
  if (children.length) add('delete_has_children', `请先移走或删除全部子任务：${children.map(item => item.title).join('、')}。`);
  return blockers;
}

export function analyze(tasks: TaskMetadata[]): { diagnostics: Diagnostic[]; ready: string[] } {
  const diagnostics: Diagnostic[] = [];
  const invalid = new Set<string>();
  const byId = new Map<string, TaskMetadata>();
  const children = childIndex(tasks);
  const report = (code: string, message: string, taskId: string, severity: Diagnostic['severity'] = 'error') => {
    diagnostics.push({ code, message, taskId, severity });
    if (severity === 'error') invalid.add(taskId);
  };
  for (const task of tasks) {
    if (byId.has(task.id)) report('DUPLICATE_ID', `Task ID ${task.id} occurs more than once.`, task.id);
    else byId.set(task.id, task);
  }

  const waits = new Map<string, string[]>();
  for (const task of byId.values()) {
    const childIds = (children.get(task.id) ?? []).filter((id) => byId.has(id) && id !== task.id);
    const dependencies = new Set<string>();
    const edges = new Set(childIds);
    if (task.parent !== null) {
      if (!byId.has(task.parent)) report('MISSING_PARENT', `Parent ${task.parent} does not exist.`, task.id);
      else if (task.parent === task.id) report('SELF_PARENT', 'A task cannot be its own parent.', task.id);
    }
    for (const dependency of task.blocked_by) {
      if (dependencies.has(dependency)) report('DUPLICATE_DEPENDENCY', `Dependency ${dependency} is listed more than once.`, task.id);
      dependencies.add(dependency);
      if (dependency === task.id) {
        report('SELF_DEPENDENCY', 'A task cannot depend on itself.', task.id);
        continue;
      }
      const target = byId.get(dependency);
      if (!target) {
        report('MISSING_DEPENDENCY', `Dependency ${dependency} does not exist.`, task.id);
        continue;
      }
      // Dependencies are only ordered within one sibling group; the parent of
      // both ends must be the same task (null is the virtual root).
      if (target.parent !== task.parent) {
        report('DEPENDENCY_SCOPE', `Dependency ${dependency} must share the same direct parent as ${task.id}; move both tasks or drop the dependency.`, task.id);
        continue;
      }
      edges.add(dependency);
    }
    waits.set(task.id, [...edges]);
    if (task.archived && task.status !== 'done' && task.status !== 'canceled') {
      report('ARCHIVED_UNFINISHED', `Archived task ${task.id} is unfinished.`, task.id);
    }
    if (!task.archived && task.parent && byId.get(task.parent)?.archived) {
      report('ARCHIVED_PARENT', `Task ${task.id} has an archived parent.`, task.id);
    }
    // Executing or completed work must satisfy the same prerequisites a start
    // would: its own direct dependencies and those of every ancestor. These are
    // warnings because they describe history an apply must not silently rewrite;
    // the store rejects plans that *introduce* them.
    if (task.status === 'in_progress' || task.status === 'done') {
      for (const blocker of blockersFor(byId, task.id)) {
        report(task.status === 'done' ? 'DONE_BLOCKED' : 'EXECUTION_BLOCKED', blocker.message, task.id, 'warning');
      }
    }
    // Starting a leaf advances its still-todo ancestors, so this only appears
    // after an external Markdown edit or a hand-written status change.
    if (task.status === 'in_progress') {
      const seen = new Set([task.id]);
      let parent = task.parent;
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const ancestor = byId.get(parent);
        if (!ancestor) break;
        if (ancestor.status === 'todo' && !ancestor.archived) {
          report('ANCESTOR_NOT_STARTED', `Executing task ${task.id} has todo ancestor ${parent}; start it so the parent chain reflects progress.`, task.id, 'warning');
        }
        parent = ancestor.parent;
      }
    }
    if (task.status === 'done') {
      const unfinishedChildren = childIds.filter((id) => {
        const status = byId.get(id)?.status;
        return status !== 'done' && status !== 'canceled';
      });
      if (unfinishedChildren.length) {
        report('DONE_WITH_UNFINISHED_CHILDREN', `Completed task ${task.id} has unfinished children: ${unfinishedChildren.join(', ')}; reopen it explicitly before adding work.`, task.id, 'warning');
      }
    }
  }

  // Iterative DFS avoids recursion limits for large or deeply nested task trees.
  const color = new Map<string, 'visiting' | 'visited'>();
  const positions = new Map<string, number>();
  for (const root of byId.keys()) {
    if (color.has(root)) continue;
    const stack: { id: string; index: number; edges: string[] }[] = [{ id: root, index: 0, edges: waits.get(root) ?? [] }];
    color.set(root, 'visiting');
    positions.set(root, 0);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      if (frame.index === frame.edges.length) {
        color.set(frame.id, 'visited');
        positions.delete(frame.id);
        stack.pop();
        continue;
      }
      const target = frame.edges[frame.index++]!;
      if (color.get(target) === 'visiting') {
        const cycle = stack.slice(positions.get(target)!).map((entry) => entry.id);
        for (const id of cycle) invalid.add(id);
        report('GRAPH_CYCLE', `Task wait graph contains a cycle: ${[...cycle, target].join(' -> ')}.`, frame.id);
      } else if (!color.has(target)) {
        color.set(target, 'visiting');
        positions.set(target, stack.length);
        stack.push({ id: target, index: 0, edges: waits.get(target) ?? [] });
      }
    }
  }

  const validPrerequisites = (task: TaskMetadata): boolean => {
    const seen = new Set<string>();
    let current: TaskMetadata | undefined = task;
    while (current) {
      if (seen.has(current.id) || invalid.has(current.id)
        || current.blocked_by.some(id => invalid.has(id))) return false;
      seen.add(current.id);
      current = current.parent === null ? undefined : byId.get(current.parent);
    }
    return true;
  };
  const ready = [...byId.values()]
    .filter((task) => !task.archived
      && task.status === 'todo'
      && !(children.get(task.id)?.length)
      && validPrerequisites(task)
      && blockersFor(byId, task.id).length === 0)
    .sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map((task) => task.id);
  return { diagnostics, ready };
}
