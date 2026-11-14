/** New DSH sessions receive the Markdown content directly, not CLI instructions. */
export interface PromptTask { id: string; title: string; repo?: string | null; body?: string }
export function initialPrompt(task: PromptTask): string {
  return [
    `工作主题：${task.title}`,
    ...(task.repo?.trim() ? [`仓库：${task.repo.trim()}`] : []),
    '', '以下共享 Markdown 正文是本次工作上下文：', '',
    task.body?.trim() || '（当前文档暂无正文。）',
    '', '无需安装或调用 taskmd CLI。完成后直接在对话中汇报结果。',
    '除非用户要求，不要仅为了同步状态而修改 Markdown。',
  ].join('\n');
}
