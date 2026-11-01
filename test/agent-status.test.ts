import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionStatus } from '../src/ui/port.js';
import {
  agentView, chipLabel, formatDuration, formatTokens, levelOf, levelRank,
} from '../src/ui/agent-status.js';

function status(over: Partial<SessionStatus> & Pick<SessionStatus, 'sessionId'>): SessionStatus {
  return { running: false, ...over };
}

test('levelOf ranks pending interaction above running', () => {
  assert.equal(levelOf(status({ sessionId: 'a', pending: 'approval', running: true })), 'attention');
  assert.equal(levelOf(status({ sessionId: 'a', running: true })), 'running');
  assert.equal(levelOf(status({ sessionId: 'a', fresh: true })), 'fresh');
  assert.equal(levelOf(status({ sessionId: 'a', archived: true, missing: true })), 'archived');
  assert.equal(levelOf(status({ sessionId: 'a', missing: true })), 'missing');
  assert.equal(levelOf(status({ sessionId: 'a', blank: true })), 'blank');
  assert.equal(levelOf(status({ sessionId: 'a' })), 'idle');
  assert.ok(levelRank.attention < levelRank.running && levelRank.running < levelRank.fresh);
});

test('agentView merges by worst level and counts buckets', () => {
  const view = agentView([
    status({ sessionId: 'idle', updatedAt: 2 }),
    status({ sessionId: 'run', running: true, updatedAt: 3 }),
    status({ sessionId: 'ask', pending: 'question' }),
    status({ sessionId: 'done', fresh: true }),
  ]);
  assert.equal(view.level, 'attention');
  assert.equal(view.attention, 1);
  assert.equal(view.running, 1);
  assert.equal(view.fresh, 1);
  assert.equal(view.active, 3);
  assert.deepEqual(view.statuses.map(item => item.sessionId), ['ask', 'run', 'done', 'idle']);
});

test('agentView on no sessions reports idle with empty counts', () => {
  const view = agentView([]);
  assert.equal(view.level, 'idle');
  assert.equal(view.statuses.length, 0);
  assert.equal(view.active, 0);
});

test('chipLabel prefers attention, then running, then fresh, then session count', () => {
  assert.equal(chipLabel(agentView([status({ sessionId: 'a', pending: 'approval' })]), 1), '⚠ 等你处理');
  assert.equal(chipLabel(agentView([
    status({ sessionId: 'a', running: true }), status({ sessionId: 'b', running: true }),
  ]), 2), '● 2 运行');
  assert.equal(chipLabel(agentView([status({ sessionId: 'a', running: true })]), 1), '● 运行中');
  assert.equal(chipLabel(agentView([status({ sessionId: 'a', fresh: true })]), 1), '✓ 新结果');
  assert.equal(chipLabel(agentView([status({ sessionId: 'a' })]), 2), '2 会话');
  assert.equal(chipLabel(agentView([status({ sessionId: 'a' })]), 1), undefined);
});

test('formatTokens stays compact', () => {
  assert.equal(formatTokens(482), '482');
  assert.equal(formatTokens(48_210), '48k');
  assert.equal(formatTokens(4_821_000), '4.8M');
  assert.equal(formatTokens(48_210_000), '48M');
});

test('formatDuration buckets minutes through months', () => {
  assert.equal(formatDuration(0), '刚刚');
  assert.equal(formatDuration(29_000), '刚刚');
  assert.equal(formatDuration(5 * 60_000), '5 分钟');
  assert.equal(formatDuration(3 * 3_600_000), '3 小时');
  assert.equal(formatDuration(2 * 86_400_000), '2 天');
  assert.equal(formatDuration(40 * 86_400_000), '1 个月');
});
