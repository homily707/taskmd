import type { TaskRecord } from '../types.js';

export { initialPrompt } from '../core/prompt.js';

/**
 * A read-only review session reviews only the code changes. It deliberately does
 * not read or rely on the task body: the task title and id are only identifiers
 * for the review scope. Scope must be established from code evidence (Git diff,
 * PR, commit or baseline) rather than inferred from the task.
 */
export function reviewPrompt(record: TaskRecord): string {
  return [
    `请作为独立代码审查者，只审查代码改动本身。不要读取、不要参考任务正文或任务 Markdown 的内容；下面的任务标题与 ID 仅用于标识审查范围，请勿打开任务文件、也不要调用 taskmd 读取任务正文。只审查，不修改文件、不自动修复、不提交代码。`,
    `任务：${record.task.title}`, `任务 ID：${record.task.id}`,
    '',
    '审查范围只依据代码证据确定：',
    '1. 先查看当前工作区的 Git 状态、暂存与未提交 Diff；若提供了 PR、提交或比较基线，检查对应差异。不要假定当前分支上的所有历史变更都属于本次审查。',
    '2. 仅审查与本次改动相关的文件；阅读必要的相邻代码、调用链和项目规则（如 AGENTS.md / CLAUDE.md），但不要无差别扫描整个仓库。若无法确定范围，直接说明限制，不要猜测。',
    '',
    '审查重点（只针对改动本身，不评价任务需求）：',
    '- 逻辑正确性、边界条件、错误处理、并发与状态一致性；',
    '- 安全、兼容性、性能回归、资源与生命周期管理；',
    '- 关键测试缺口；有无无必要的额外实现、死代码或与改动无关的修改。',
    '优先找出真实可触发、值得修复的问题。',
    '',
    '只报告本次改动引入的、具体且可修复的问题；忽略既有问题、纯风格意见、格式化器能处理的问题和无法证实的风险，不要为了凑数量制造问题。',
    '', '输出要求：',
    '- 先列问题，按严重程度排序（P0 阻断 / P1 严重 / P2 一般 / P3 轻微）。每项给出文件与准确行号、触发条件、影响和简短修复建议。',
    '- 最后简短说明审查覆盖的文件/范围及未覆盖的风险；不要评价任务是否完成或是否符合任务要求（因为未阅读任务）。',
    '- 若未发现明确问题，请直接说明“未发现明确问题”，并列出重要的范围或测试限制。',
    '- 不需要重复进行全面测试或自证；已有证据足以支持结论时即停止。',
  ].join('\n');
}
