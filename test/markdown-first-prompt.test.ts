import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPrompt } from '../src/ui/prompt.js';

test('new sessions receive Markdown directly and never require taskmd commands', () => {
  const prompt = initialPrompt({ id: 'task-a', title: 'Refactor', repo: 'example', body: '# Requirements\nUse Markdown links.' });
  assert.match(prompt, /# Requirements/);
  assert.match(prompt, /Use Markdown links/);
  assert.match(prompt, /example/);
  assert.doesNotMatch(prompt, /taskmd context|taskmd check/);
});
test('empty Markdown gives a usable prompt', () => {
  const prompt = initialPrompt({ id: 'task-a', title: 'New document' });
  assert.match(prompt, /New document/);
  assert.match(prompt, /暂无正文/);
});
