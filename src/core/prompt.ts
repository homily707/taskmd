import type { TaskRecord } from '../types.js';

/** Task identity and launch guidance only; the Agent reads the latest task on start. */
export function initialPrompt(record: Pick<TaskRecord, 'task' | 'path'>): string {
  return [
    `任务：${record.task.title}`, `任务 ID：${record.task.id}`, `任务文件：${record.path}`,
    '',
    '先调用 taskmd 工具（action=read，taskId 为上述任务 ID）读取最新任务内容，再根据任务要求开展工作。',
    '',
    '开始前：',
    '- 理解任务目标、要求和验收标准；先阅读已有的进展、工作笔记和工作材料，避免重复调查。',
    '- 优先查阅任务明确引用的前置或相关任务；确需复用历史经验时，再通过 taskmd list 查找。',
    '',
    '执行中：',
    '- “## 进展”：覆盖式更新当前状态、待解决问题和下一步；保持简洁，不写流水账。',
    '- “## 工作笔记”：按主题整理重要发现、方案取舍和踩坑经验，合并重复或失效的结论。',
    '- “## 工作材料”：保存难以重新获取的查询结果、指标、日志和实验数据等；记录必要的来源、时间范围和引用位置。大量原始材料放独立文件，正文只保留索引。',
    '- 有实质结论或阶段变化时及时更新；章节按需维护，不要求填满。',
    '- summary 用一句话概括任务目的及必要的当前阶段，缺失或阶段明显变化时更新即可。',
    '- 用户维护目标、要求和验收标准；未经要求不要修改任务状态。',
    '- 编辑任务时保留 frontmatter；任务文件不可访问时，使用 taskmd read/update，并按 expectedVersion 处理冲突。',
  ].join('\n');
}
