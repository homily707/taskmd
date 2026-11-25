import type { TaskRecord } from '../types.js';

/** Editable defaults are copied to the user's taskmd data directory once. */
export const DEFAULT_INITIAL_PROMPT = [
    '任务：{{title}}', '任务 ID：{{id}}', '任务文件：{{path}}',
    '',
    '开始前：',
    '- 读任务文件，理解目标、要求和验收标准，并了解已有进展、工作笔记和工作材料，避免重复调查。',
    '',
    '执行中：',
    '- “## 进展”：覆盖式更新当前状态、待解决问题和下一步；保持简洁，不写流水账。',
    '- “## 工作笔记”：按主题整理重要发现、方案取舍和踩坑经验，合并重复或失效的结论。',
    '- “## 工作材料”：保存难以重新获取的查询结果、指标、日志和实验数据等；记录必要的来源、时间范围和引用位置。大量原始材料放独立文件，正文只保留索引。',
    '- 有实质结论或阶段变化时及时更新；章节按需维护，不要求填满。',
    '- summary 用一句话概括任务目的及必要的当前阶段，缺失或阶段明显变化时更新即可。',
    '- 用户维护目标、要求和验收标准；未经要求不要修改任务状态。',
    '- 编辑任务时保留 frontmatter；若文件不可访问，说明情况，不要凭记忆编造内容。',
  ].join('\n');
export const DEFAULT_REVIEW_PROMPT = [
    '任务：{{title}}', '任务 ID：{{id}}', '任务文件：{{path}}',
    '',
    '请以独立审查者的视角，审查这个任务对应的代码实现。任务文件只用于定位相关仓库和改动，不要审查任务本身的记录或工作过程（进展、笔记、任务拆解、流程是否规范等）。',
    '',
    '审查代码时重点看：',
    '',
    '1. **正确性**：实现是否真正满足任务目标？逻辑、边界情况、失败与异常路径是否处理正确？',
    '2. **与现有代码的一致性**：是否复用了已有能力，是否与既有接口、约定和风格一致？有没有重复实现或与现有系统冲突？',
    '3. **简洁性**：有没有不必要的复杂度、冗余代码或本可以更简单的实现？',
    '4. **健壮性与可维护性**：错误处理、类型、命名和可读性是否合理？有没有难以发现的坑？',
    '',
    '**输出要求：**',
    '- 只报告真正值得关注的问题，按重要程度排序。',
    '- 每个问题说明位置（文件/函数）、原因、影响和建议，不要只提出疑问。',
    '- 区分已确认的问题与尚待验证的风险。',
    '- 没有明显问题就直接说明，不强行挑错。',
    '- 不扩大任务范围，不直接修改代码，等待我决定。',
    '- 如果任务没有对应的代码实现，直接说明没有可审查的代码。',
  ].join('\n');
export const DEFAULT_TASK_TEMPLATE = [
  '## 目标', '', '## 工作内容', '', '## 进展', '',
  '## 工作笔记', '', '## 工作材料', '',
].join('\n');

/** Only these task-identity placeholders are interpolated; all other text is preserved. */
export function renderTaskPrompt(record: Pick<TaskRecord, 'task' | 'path'>, template: string): string {
  const values: Record<string, string> = {
    title: record.task.title, id: record.task.id, path: record.path,
  };
  return template.replace(/\{\{(title|id|path)\}\}/g, (_, key: string) => values[key]);
}
export function initialPrompt(record: Pick<TaskRecord, 'task' | 'path'>, template = DEFAULT_INITIAL_PROMPT): string {
  return renderTaskPrompt(record, template);
}
export function reviewPrompt(record: Pick<TaskRecord, 'task' | 'path'>, template = DEFAULT_REVIEW_PROMPT): string {
  return renderTaskPrompt(record, template);
}
