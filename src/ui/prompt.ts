import type { TaskRecord } from '../types.js';

export { initialPrompt } from '../core/prompt.js';

/**
 * A review session re-examines the task and its design. The wording mirrors
 * `agents/prompts/review.md`; only the task identity is prepended to scope it.
 */
export function reviewPrompt(record: TaskRecord): string {
  return [
    `任务：${record.task.title}`, `任务 ID：${record.task.id}`, `任务文件：${record.path}`,
    '',
    '请以独立审查者的视角，重新审视当前任务及其设计方案。不要默认已有方案正确，也不要为了挑错而挑错。',
    '',
    '依次从以下角度审查：',
    '',
    '1. **整体合理性**：是否真正解决问题？有没有更简单的方案、可复用的现有能力或不必要的复杂度？',
    '2. **完整性与清晰度**：目标、边界、约束和关键假设是否明确？有没有遗漏、歧义或隐含前提？',
    '3. **设计正确性**：关键决策和权衡是否合理？是否存在逻辑缺陷、边界情况、失败场景或与现有系统冲突的问题？',
    '4. **实现可行性**：方案是否足以指导实施？哪些关键细节尚未确定？如涉及代码，优先依据实际代码判断。',
    '5. **再次审视整体**：结合发现的问题，判断是否需要简化或调整方案，避免修补问题时引入新的复杂度。',
    '',
    '**输出要求：**',
    '- 只报告真正值得关注的问题，按重要程度排序。',
    '- 每个问题说明原因、影响和建议，不要只提出疑问。',
    '- 区分已确认的问题与尚待验证的风险。',
    '- 没有明显问题就直接说明，不强行挑错。',
    '- 不扩大任务范围，不直接修改代码或方案，等待我决定。',
  ].join('\n');
}
