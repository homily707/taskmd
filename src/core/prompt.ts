import type { TaskRecord } from '../types.js';

/** The exact saved body frozen by the Session launcher, shared by UI and Host auto-launch. */
export function initialPrompt(record: Pick<TaskRecord, 'task' | 'path'>): string {
  return [
    `任务：${record.task.title}`, `任务 ID：${record.task.id}`, `Markdown：${record.path}`,
    '', '以下是已保存的任务正文：', '', record.task.body || '（暂无正文。）',
    '', '请根据任务正文开展工作。',
    '', '这份任务文件同时是工作记录。接手本任务的会话和以后做相似任务的会话都看不到本次对话，只能靠它了解情况。',
    '- 开工前：正文链接了前置或相似任务时先读它们；没有链接时，可以在任务文件所在目录里搜索相似任务，读它的“进展”小节。旧记录只反映当时的情况，与当前代码不符时以代码为准。',
    '- 执行中：在正文末尾维护“## 进展”小节，覆盖式写明当前状态、已做的决定、放弃的方案及原因、关键文件与验证方法、踩过的坑和下一步，并注明日期和相关 commit。',
    '- 不要等到任务结束才写，会话可能随时中断。一个结论定下来、费了功夫才弄清一件事、完成一个阶段、要开始很长或有风险的操作、用户要求交接时，当场更新变化的部分。结论未定或只是等用户回复时不用更新。',
    '- 目标、要求和验收标准由用户维护，认为需要调整时先向用户提出。',
    '- 正文直接编辑上面的 Markdown 文件并保留 frontmatter；文件无法访问时改用 taskmd 工具。标题、状态、层级和会话关联用 taskmd 工具修改。任务状态与会话状态独立，用户没有要求时不要改。',
  ].join('\n');
}
