import type { TaskRecord } from '../types.js';

/** The exact saved body frozen by the Session launcher, shared by UI and Host auto-launch. */
export function initialPrompt(record: Pick<TaskRecord, 'task' | 'path'>): string {
  return [
    `任务：${record.task.title}`, `任务 ID：${record.task.id}`, `Markdown：${record.path}`,
    '', '以下是已保存的任务正文：', '', record.task.body || '（暂无正文。）',
    '', '请根据任务正文开展工作。任务状态与会话状态独立；需要修改任务时使用 taskmd 工具。',
  ].join('\n');
}
