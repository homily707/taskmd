import type { Task, TaskRecord, TaskStatus } from '../types.js';
import { compareTasks } from './shared.js';

/** Archived ancestors hide their whole branch, including during search. */
export function outlineRows(records: TaskRecord[], collapsed = new Set<string>(), showArchived = false, query = '', status?: TaskStatus) {
  const tasks = records.map(record => record.task);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visible = tasks.filter(task => {
    const seen = new Set<string>();
    let cursor: Task | undefined = task;
    while (cursor && !seen.has(cursor.id)) {
      if (!showArchived && cursor.archived) return false;
      seen.add(cursor.id); cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
    }
    return true;
  });
  const matching = new Set<string>();
  for (const task of visible) if ((!status || task.status === status) && `${task.title} ${task.id}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) {
    let cursor: Task | undefined = task;
    while (cursor && !matching.has(cursor.id)) { matching.add(cursor.id); cursor = cursor.parent ? byId.get(cursor.parent) : undefined; }
  }
  const children = new Map<string | null, Task[]>();
  for (const task of visible) if (matching.has(task.id)) {
    const parent = task.parent && byId.has(task.parent) ? task.parent : null;
    children.set(parent, [...children.get(parent) ?? [], task]);
  }
  const rows: { task: Task; depth: number; hasChildren: boolean }[] = [];
  const visited = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    for (const task of (children.get(parent) ?? []).sort(compareTasks)) {
      if (visited.has(task.id)) continue;
      visited.add(task.id); rows.push({ task, depth, hasChildren: !!children.get(task.id)?.length });
      if (query || status || !collapsed.has(task.id)) visit(task.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** One file update moves a sibling; no multi-file transaction is necessary. */
export function movedOrder(tasks: Task[], id: string, direction: -1 | 1): number | undefined {
  const current = tasks.find(task => task.id === id);
  if (!current) return;
  const siblings = tasks.filter(task => task.parent === current.parent).sort(compareTasks);
  const index = siblings.findIndex(task => task.id === id);
  const target = index + direction;
  if (target < 0 || target >= siblings.length) return;
  const adjacent = siblings[target]!;
  const outer = siblings[target + direction];
  if (!outer) return adjacent.order + direction;
  const value = adjacent.order + (outer.order - adjacent.order) / 2;
  if (value === adjacent.order || value === outer.order) throw new Error('相邻任务排序值重合，请在任务设置中调整排序值。');
  return value;
}
