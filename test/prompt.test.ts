import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskRecord } from '../src/types.js';
import { initialPrompt } from '../src/core/prompt.js';
import { reviewPrompt } from '../src/ui/prompt.js';

const task: TaskRecord = {
  task: {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Avoid repeated investigation',
    status: 'todo',
    parent: null,
    order: 0,
    archived: false,
    body: 'CONFIDENTIAL_TASK_BODY_NOT_FOR_PROMPT',
  },
  content: 'stored task content',
  version: 'v1',
  path: '/home/tasks/example.md',
};

test('launch prompt contains task identity and guidance but not a task body snapshot', () => {
  const prompt = initialPrompt(task);
  assert.match(prompt, /Avoid repeated investigation/);
  assert.match(prompt, /11111111-1111-4111-8111-111111111111/);
  assert.doesNotMatch(prompt, /action=read/);
  assert.match(prompt, /任务文件：/);
  assert.match(prompt, /工作笔记/);
  assert.match(prompt, /工作材料/);
  assert.doesNotMatch(prompt, /CONFIDENTIAL_TASK_BODY_NOT_FOR_PROMPT/);
  assert.doesNotMatch(prompt, /AGENTS\.md/);
});

test('review prompt focuses on the code implementation, not the task process', () => {
  const prompt = reviewPrompt(task);
  assert.doesNotMatch(prompt, /action=read/);
  assert.match(prompt, /独立审查者/);
  assert.match(prompt, /代码实现/);
  assert.match(prompt, /不要审查任务本身/);
  assert.match(prompt, /输出要求/);
  assert.match(prompt, /不直接修改代码/);
  assert.doesNotMatch(prompt, /CONFIDENTIAL_TASK_BODY_NOT_FOR_PROMPT/);
});
