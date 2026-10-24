/**
 * Initial-prompt text for a Session created from a Task.
 *
 * This module only renders editable text. The launcher sends it after the
 * user explicitly starts creation, binding and model selection.
 */

export interface PromptTask {
  id: string;
  title: string;
  repo?: string | null;
}

/** The command the prompt tells the agent to read its context with. */
export const contextCommand = (id: string) => `taskmd context ${id}`;

/** Renders the default editable prompt for a Task. */
export function initialPrompt(task: PromptTask): string {
  const repo = task.repo?.trim();
  return [
    `开始做任务：${task.title}`,
    '',
    `- 任务 ID：${task.id}`,
    ...(repo ? [`- 仓库：${repo}`] : []),
    '',
    `先运行 \`${contextCommand(task.id)}\` 读取任务上下文（正文、父任务、依赖、子任务），确认理解后再动手。`,
    '',
    '做完后把结果写回任务正文的「实施结果」一节，并运行 `taskmd check`。',
  ].join('\n');
}
