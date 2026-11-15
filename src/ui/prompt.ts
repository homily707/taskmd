import type { TaskRecord } from '../types.js';

/** The exact saved body is frozen before Session creation or delivery. */
export function initialPrompt(record: TaskRecord): string {
  return [
    `任务：${record.task.title}`, `任务 ID：${record.task.id}`, `Markdown：${record.path}`,
    '', '以下是已保存的任务正文：', '', record.task.body || '（暂无正文。）',
    '', '请根据任务正文开展工作。任务状态与会话状态独立；需要修改任务时使用 taskmd 工具。',
  ].join('\n');
}

/**
 * A read-only review session shares the task and repository with an execution
 * session, but does not assume their working trees or Git bases are identical.
 * Scope must be established from evidence rather than inferred from task id.
 */
export function reviewPrompt(record: TaskRecord): string {
  return [
    `请作为独立代码审查者审查与以下任务相关的改动。只审查，不修改文件、不自动修复、不提交代码。`,
    `任务：${record.task.title}`, `任务 ID：${record.task.id}`, `任务 Markdown：${record.path}`,
    '', '任务要求：', record.task.body || '（暂无正文。）',
    '', '审查步骤：',
    '1. 先查看当前工作区的 Git 状态、暂存与未提交 Diff。若任务描述提供了 PR、提交或比较基线，也检查对应差异。不要假定当前分支上的所有历史变更都属于本任务。',
    '2. 仅选择与本任务有关的变更文件。阅读必要的相邻代码、调用链和项目规则（如 AGENTS.md / CLAUDE.md），但不要无差别扫描整个仓库。若无法确定对应文件或比较范围，明确指出限制，不要猜测。',
    '3. 检查：是否符合任务要求、有无遗漏或无必要的额外实现；逻辑与边界条件、错误处理、安全、兼容性、性能回归、关键测试缺口。优先找真实可触发的问题。',
    '4. 只报告本次改动引入的、具体且值得修复的问题。忽略既有问题、纯风格意见、格式化器能处理的问题和无法证实的风险。不要为了凑数量制造问题。',
    '', '输出要求：',
    '- 先列问题，按严重程度排序（P0 阻断 / P1 严重 / P2 一般 / P3 轻微）。每项给出文件与准确行号、触发条件、影响和简短修复建议。',
    '- 最后简短说明审查覆盖的文件、与任务要求的偏差及未覆盖的风险。',
    '- 若未发现明确问题，请直接说明“未发现明确问题”，并列出重要的范围或测试限制。',
    '- 不需要重复进行全面测试或自证；已有证据足以支持结论时即停止。',
  ].join('\n');
}
