import type { SessionStatus } from './port.js';

/**
 * Display-only aggregation of the sessions bound to one Task (or rolled up
 * over a subtree). Nothing here writes task state; hints stay soft.
 */
export type AgentLevel = 'attention' | 'running' | 'fresh' | 'idle' | 'blank' | 'archived' | 'missing';

/** Lower rank wins when one Task owns several sessions. */
export const levelRank: Record<AgentLevel, number> = {
  attention: 0, running: 1, fresh: 2, idle: 3, blank: 4, archived: 5, missing: 6,
};

export const levelLabels: Record<AgentLevel, string> = {
  attention: '等你处理', running: '运行中', fresh: '有新结果', idle: '空闲',
  blank: '未开始对话', archived: '已归档', missing: '不存在',
};

export function levelOf(status: SessionStatus): AgentLevel {
  if (status.pending) return 'attention';
  if (status.running) return 'running';
  if (status.fresh) return 'fresh';
  if (status.archived) return 'archived';
  if (status.missing) return 'missing';
  if (status.blank) return 'blank';
  return 'idle';
}

export interface TaskAgentView {
  level: AgentLevel;
  /** Sessions in the worst-first order used by the detail card. */
  statuses: SessionStatus[];
  active: number;
  attention: number;
  running: number;
  fresh: number;
}

/** Merges one Task's (or one subtree's) sessions into a single chip view. */
export function agentView(statuses: SessionStatus[]): TaskAgentView {
  const sorted = [...statuses].sort((a, b) => {
    const rank = levelRank[levelOf(a)] - levelRank[levelOf(b)];
    return rank !== 0 ? rank : (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
  const levels = sorted.map(levelOf);
  const count = (level: AgentLevel) => levels.filter(item => item === level).length;
  return {
    level: sorted.length ? levels[0]! : 'idle',
    statuses: sorted,
    attention: count('attention'),
    running: count('running'),
    fresh: count('fresh'),
    active: count('attention') + count('running') + count('fresh'),
  };
}

/** `48210` → `48k`; `4821000` → `4.8M`. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** Compact relative activity for chip and card display. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天`;
  return `${Math.round(days / 30)} 个月`;
}

/** Relative label against a provided clock, so tests stay deterministic. */
export function relativeActivity(status: SessionStatus, now: number): string {
  return status.updatedAt === undefined ? '—' : formatDuration(now - status.updatedAt);
}

/** Short chip label for one merged view, or `undefined` to render nothing. */
export function chipLabel(view: TaskAgentView, sessionCount: number): string | undefined {
  if (view.attention > 0) return view.attention > 1 ? `⚠ ${view.attention} 等处理` : '⚠ 等你处理';
  if (view.running > 0) return view.running > 1 ? `● ${view.running} 运行` : '● 运行中';
  if (view.fresh > 0) return view.fresh > 1 ? `✓ ${view.fresh} 新结果` : '✓ 新结果';
  if (sessionCount > 1) return `${sessionCount} 会话`;
  return undefined;
}
