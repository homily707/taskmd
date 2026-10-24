import { generateNKeysBetween } from 'fractional-indexing';
import type { Operation, Task } from '../types.js';
import { compareTasks, descendants } from './shared.js';

export type Placement = 'before' | 'after' | 'inside';
/** Validate both incoming and outgoing edges against the proposed final parent. */
export function moveOperations(tasks: Task[], id: string, targetId: string, placement: Placement): Operation[] {
  const task = tasks.find(t => t.id === id), target = tasks.find(t => t.id === targetId);
  if (!task || !target) throw new Error('任务已不存在，请刷新后重试。');
  const parent = placement === 'inside' ? target.id : target.parent;
  if (id === targetId || (parent !== null && descendants(tasks, id).has(parent))) throw new Error('不能移动到自身或后代。');
  if (task.archived || target.archived) throw new Error('请先恢复归档任务。');
  if (parent !== task.parent) {
    const invalid = tasks.flatMap(t => t.blocked_by.flatMap(dep => {
      const dependency = tasks.find(d => d.id === dep);
      if (!dependency || (t.id !== id && dependency.id !== id)) return [];
      const a = t.id === id ? parent : t.parent, b = dependency.id === id ? parent : dependency.parent;
      return a === b ? [] : [`“${t.title}”依赖“${dependency.title}”`];
    }));
    if (invalid.length) throw new Error(`移动会产生跨父依赖：${invalid.join('；')}。请显式调整依赖，或通过 apply 联合移动两端。`);
  }
  const siblings = tasks.filter(t => t.parent === parent && t.id !== id).sort(compareTasks);
  const index = placement === 'inside' ? siblings.length : siblings.findIndex(t => t.id === targetId) + (placement === 'after' ? 1 : 0);
  siblings.splice(index, 0, task);
  const orders = generateNKeysBetween(null, null, siblings.length);
  return siblings.flatMap((t, i): Operation[] => t.id === id ? [{ op: 'patch', id, changes: { parent, order: orders[i]! } }]
    : t.order !== orders[i] ? [{ op: 'patch', id: t.id, changes: { order: orders[i]! } }] : []);
}
export function indentOperations(tasks: Task[], id: string, outdent: boolean): Operation[] {
  const task = tasks.find(t => t.id === id);
  if (!task) throw new Error('任务已不存在。');
  if (outdent) {
    if (!task.parent) throw new Error('根任务不能继续反缩进。');
    return moveOperations(tasks, id, task.parent, 'after');
  }
  const siblings = tasks.filter(t => t.parent === task.parent && !t.archived).sort(compareTasks);
  const previous = siblings[siblings.findIndex(t => t.id === id) - 1];
  if (!previous) throw new Error('没有可作为父任务的前一个同级任务。');
  return moveOperations(tasks, id, previous.id, 'inside');
}
export function outlineRows(tasks: Task[], collapsed: Set<string>) {
  const ids = new Set(tasks.map(t => t.id));
  const children = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const parent = task.parent && ids.has(task.parent) ? task.parent : null;
    children.set(parent, [...children.get(parent) || [], task]);
  }
  for (const list of children.values()) list.sort(compareTasks);
  const rows: { task: Task; depth: number }[] = [], seen = new Set<string>();
  const visit = (task: Task, depth: number) => {
    if (seen.has(task.id)) return;
    seen.add(task.id); rows.push({ task, depth });
    if (!collapsed.has(task.id)) for (const child of children.get(task.id) || []) visit(child, depth + 1);
  };
  for (const root of children.get(null) || []) visit(root, 0);
  // Cycles/missing parents remain inspectable; valid collapsed descendants stay hidden.
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    let cursor: Task | undefined = task; const chain = new Set<string>(); let hidden = false;
    while (cursor?.parent && !chain.has(cursor.id)) {
      chain.add(cursor.id); if (collapsed.has(cursor.parent)) { hidden = true; break; }
      cursor = tasks.find(t => t.id === cursor!.parent);
    }
    if (!hidden) visit(task, 0);
  }
  return rows;
}
