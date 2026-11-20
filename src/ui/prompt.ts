import type { TaskRecord } from '../types.js';

export { initialPrompt } from '../core/prompt.js';

/**
 * A review session examines the code implementation behind a task. The wording
 * mirrors `agents/prompts/review.md`; only the task identity is prepended to
 * scope it.
 */
export function reviewPrompt(record: TaskRecord): string {
  return [
    `任务：${record.task.title}`, `任务 ID：${record.task.id}`, `任务文件：${record.path}`,
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
}
