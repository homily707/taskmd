import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { TaskSessionLauncher } from '../src/ui/session-launcher.js';
import type { ModelCatalog, SessionCapability } from '../src/ui/port.js';
import type { Task } from '../src/types.js';

const task: Task = { schema: 1, id: 'task-1', title: 'Task', repo: 'A', body: '', status: 'todo', parent: null, blocked_by: [], order: 'a0', assets: [], archived: false };
const workspaces = ['A', 'B'].map(name => ({ workspaceId: `w${name}`, path: `/repo/${name}`, title: name }));
const catalog: ModelCatalog = { default: { provider: 'p', model: 'm' }, routableProviders: ['p'], failures: [], groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] } }] }] };
function capability(overrides: Partial<SessionCapability> = {}): SessionCapability {
  return { list: async () => [], open: async () => {}, bind: async () => {}, unbind: async () => {}, create: async () => ({ sessionId: 's-1' }), directory: async () => '/repo/A', workspaces: async () => workspaces, ...overrides };
}
function text(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}
function button(view: ReactTestRenderer, label: string) {
  return view.root.findAllByType('button').find(node => text(node) === label)!;
}
function field(view: ReactTestRenderer, label: string, type: 'input' | 'select' = 'input') {
  return view.root.findAllByType('label').find(node => text(node).startsWith(label))!.findByType(type);
}
async function mount(t: { after(fn: () => void): void }, cap: SessionCapability, initial = task) {
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(TaskSessionLauncher, { task: initial, capability: cap })); });
  t.after(() => act(() => view.unmount()));
  return view;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

for (const repo of ['A', null]) {
  test(`manual directory reaches the capability with repo ${repo}`, async t => {
    const calls: unknown[] = [];
    const view = await mount(t, capability({ directory: async () => repo ? '/repo/A' : null, create: async (_id, options) => { calls.push(options); return { sessionId: 's-1' }; } }), { ...task, repo });
    act(() => field(view, '改用其他工作目录').props.onChange({ target: { value: '/manual/override' } }));
    await act(async () => button(view, '创建并绑定会话').props.onClick());
    assert.deepEqual(calls, [{ directory: '/manual/override' }]);
  });
}

test('clearing a rejected preset retries once without sending the old preset', async t => {
  const calls: Parameters<SessionCapability['create']>[1][] = [];
  const view = await mount(t, capability({ create: async (_id, options) => {
    calls.push(options);
    if (options.agentPreset) throw Object.assign(new Error('invalid preset'), { code: 'agent-preset/invalid' });
    return { sessionId: 's-1' };
  } }));
  act(() => field(view, 'Agent preset').props.onChange({ target: { value: 'broken' } }));
  await act(async () => button(view, '创建并绑定会话').props.onClick());
  await act(async () => button(view, '清空 preset 用默认值重试').props.onClick());
  assert.deepEqual(calls, [{ workspaceId: 'wA', agentPreset: 'broken' }, { workspaceId: 'wA' }]);
  assert.equal(field(view, 'Agent preset').props.value, '');
  assert.ok(button(view, '打开会话'));
});

for (const manual of [false, true]) {
  test(`changing repo invalidates the old target while loading (manual=${manual})`, async t => {
    const next = deferred<string>();
    const calls: unknown[] = [];
    let reads = 0;
    const cap = capability({ directory: () => ++reads === 1 ? Promise.resolve('/repo/A') : next.promise, create: async (_id, options) => { calls.push(options); return { sessionId: 's-1' }; } });
    const view = await mount(t, cap);
    if (manual) act(() => field(view, '改用其他工作目录').props.onChange({ target: { value: '/old/override' } }));
    await act(async () => view.update(createElement(TaskSessionLauncher, { task: { ...task, repo: 'B' }, capability: cap })));
    assert.equal(button(view, '创建并绑定会话').props.disabled, true);
    assert.equal(field(view, '改用其他工作目录').props.value, '');
    await act(async () => next.resolve('/repo/B'));
    await act(async () => button(view, '创建并绑定会话').props.onClick());
    assert.equal(reads, 2);
    assert.deepEqual(calls, [{ workspaceId: 'wB' }]);
  });
}

test('a late old repository lookup cannot replace the new target', async t => {
  const old = deferred<string>();
  let reads = 0;
  const calls: unknown[] = [];
  const cap = capability({ directory: () => ++reads === 1 ? old.promise : Promise.resolve('/repo/B'), create: async (_id, options) => { calls.push(options); return { sessionId: 's-1' }; } });
  const view = await mount(t, cap);
  await act(async () => view.update(createElement(TaskSessionLauncher, { task: { ...task, repo: 'B' }, capability: cap })));
  await act(async () => old.resolve('/repo/A'));
  await act(async () => button(view, '创建并绑定会话').props.onClick());
  assert.deepEqual(calls, [{ workspaceId: 'wB' }]);
});

test('model failure resumes the same session before sending and opening', async t => {
  const calls: unknown[] = [];
  let creates = 0, selections = 0;
  const view = await mount(t, capability({
    catalog: async () => catalog,
    create: async () => { creates++; calls.push('create+bind'); return { sessionId: 's-1' }; },
    selectModel: async (id, selection) => {
      calls.push(['model', id, selection]);
      if (++selections === 1) throw new Error('temporarily refused');
    },
    send: async (id, prompt, requestId) => { calls.push(['send', id, prompt, requestId]); },
    open: async id => { calls.push(['open', id]); },
  }));
  act(() => field(view, '模型', 'select').props.onChange({ target: { value: 'p\u0000m' } }));
  act(() => view.root.findByType('textarea').props.onChange({ target: { value: '先执行指定任务' } }));
  assert.equal(creates, 0, 'all configuration happens before creating a session');
  await act(async () => button(view, '创建并发送首条消息').props.onClick());
  assert.match(text(view.root), /设置模型失败：temporarily refused/);
  assert.equal(calls.length, 2, 'failed model setup must not send or open');
  assert.equal(field(view, '模型', 'select').props.value, 'p\u0000m');
  assert.equal(field(view, '推理强度', 'select').props.value, 'high');
  await act(async () => button(view, '继续执行').props.onClick());
  assert.equal(creates, 1);
  assert.deepEqual(calls[2], ['model', 's-1', { provider: 'p', model: 'm', reasoningEffort: 'high' }]);
  assert.deepEqual((calls[3] as unknown[]).slice(0, 3), ['send', 's-1', '先执行指定任务']);
  assert.deepEqual(calls[4], ['open', 's-1']);
  assert.match(text(view.root), /首条消息已发送/);
});

test('model catalog can be retried before creating any session', async t => {
  let reads = 0, creates = 0;
  const view = await mount(t, capability({ create: async () => { creates++; return { sessionId: 's-1' }; }, catalog: async () => { if (++reads === 1) throw new Error('offline'); return catalog; }, selectModel: async () => {} }));
  assert.match(text(view.root), /读取模型目录失败：offline/);
  await act(async () => button(view, '重试读取模型目录').props.onClick());
  assert.ok(field(view, '模型', 'select'));
  assert.equal(creates, 0);
  assert.equal(reads, 2);
});

test('a lost send acknowledgement retries the same request and frozen text', async t => {
  const deliveries: unknown[] = [];
  const accepted = new Set<string>();
  let creates = 0, opens = 0;
  const view = await mount(t, capability({
    create: async () => { creates++; return { sessionId: 's-1' }; },
    send: async (id, prompt, requestId) => {
      deliveries.push([id, prompt, requestId]);
      if (!accepted.has(requestId)) { accepted.add(requestId); throw new Error('ack lost'); }
    },
    open: async () => { opens++; },
  }));
  await act(async () => button(view, '创建并发送首条消息').props.onClick());
  assert.equal(opens, 0);
  assert.equal(view.root.findByType('textarea').props.disabled, true, 'a possibly accepted delivery cannot change');
  await act(async () => button(view, '继续执行').props.onClick());
  assert.equal(creates, 1);
  assert.equal(opens, 1);
  assert.equal(accepted.size, 1);
  assert.deepEqual(deliveries[0], deliveries[1]);
});

test('an open failure retries navigation without creating or sending again', async t => {
  let creates = 0, sends = 0, opens = 0;
  const view = await mount(t, capability({
    create: async () => { creates++; return { sessionId: 's-1' }; },
    send: async () => { sends++; },
    open: async () => { if (++opens === 1) throw new Error('navigation failed'); },
  }));
  await act(async () => button(view, '创建并发送首条消息').props.onClick());
  assert.match(text(view.root), /打开会话失败/);
  await act(async () => button(view, '继续执行').props.onClick());
  assert.deepEqual([creates, sends, opens], [1, 1, 2]);
});

test('binding failure retains the created session and resumes binding before sending', async t => {
  const calls: string[] = [];
  const view = await mount(t, capability({
    create: async () => { calls.push('create'); throw Object.assign(new Error('bind failed'), { code: 'session_bind_failed', details: { sessionId: 's-1' } }); },
    bind: async (taskId, sessionId) => { calls.push(`bind:${taskId}:${sessionId}`); },
    send: async () => { calls.push('send'); },
    open: async () => { calls.push('open'); },
  }));
  await act(async () => button(view, '创建并发送首条消息').props.onClick());
  assert.deepEqual(calls, ['create']);
  await act(async () => button(view, '继续执行').props.onClick());
  assert.deepEqual(calls, ['create', 'bind:task-1:s-1', 'send', 'open']);
});

test('workspace attachment failure never continues to send', async t => {
  let sends = 0;
  const view = await mount(t, capability({
    create: async () => { throw Object.assign(new Error('attach failed'), { code: 'session_attach_failed', details: { sessionId: 's-1' } }); },
    send: async () => { sends++; },
  }));
  await act(async () => button(view, '创建并发送首条消息').props.onClick());
  assert.equal(button(view, '继续执行').props.disabled, true);
  assert.ok(button(view, '打开会话'));
  assert.equal(sends, 0);
});

test('duplicate clicks cannot create two sessions and an empty prompt cannot start', async t => {
  const pending = deferred<{ sessionId: string }>();
  let creates = 0, sends = 0;
  const view = await mount(t, capability({
    create: async () => { creates++; return pending.promise; }, send: async () => { sends++; },
  }));
  act(() => view.root.findByType('textarea').props.onChange({ target: { value: '   ' } }));
  assert.equal(button(view, '创建并发送首条消息').props.disabled, true);
  await act(async () => button(view, '创建并发送首条消息').props.onClick());
  assert.equal(creates, 0);
  act(() => view.root.findByType('textarea').props.onChange({ target: { value: 'go' } }));
  const click = button(view, '创建并发送首条消息').props.onClick;
  await act(async () => { click(); click(); });
  assert.equal(creates, 1);
  await act(async () => pending.resolve({ sessionId: 's-1' }));
  assert.equal(sends, 1);
});
