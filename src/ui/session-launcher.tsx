import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelCatalog, ModelSelection, SessionCapability, WorkspaceSummary } from './port.js';
import { matchWorkspace, type WorkspaceMatch } from '../core/workspace-match.js';
import { initialPrompt } from './prompt.js';
import { createOptions, describeFailure, resolveTarget, type Failure } from './session-target.js';
import type { Task } from '../types.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The DSH Workspace a Task's repository resolves to, plus every alternative.
 *
 * Resolution is read-only: it loads the Task's registered repository directory
 * and the Client's Workspace list, then defers the decision to the pure matcher.
 * A missing Workspace service is not fatal — the section falls back to the
 * repository directory, which `sessions.create` accepts as `cwd`.
 */
function useWorkspaceTarget(task: Task, capability: SessionCapability) {
  const [loaded, setLoaded] = useState<{
    taskId: string; repo: Task['repo']; capability: SessionCapability;
    workspaces: WorkspaceSummary[]; directory: string | null; error: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      let error = '';
      // An unmapped repository must not hide workspaces that match by name.
      const [directory, workspaces] = await Promise.all([
        capability.directory
          ? capability.directory(task.id, controller.signal).catch(() => null)
          : Promise.resolve(null),
        capability.workspaces
          ? capability.workspaces(controller.signal).catch((cause: unknown) => {
            error = messageOf(cause);
            return [] as WorkspaceSummary[];
          })
          : Promise.resolve([] as WorkspaceSummary[]),
      ]);
      if (!controller.signal.aborted) {
        setLoaded({ taskId: task.id, repo: task.repo, capability, directory, workspaces, error });
      }
    })();
    return () => controller.abort();
  }, [capability, task.id, task.repo]);
  // Invalidate synchronously, including the render before the new effect runs.
  const current = loaded?.taskId === task.id && loaded.repo === task.repo && loaded.capability === capability
    ? loaded : undefined;
  const workspaces = current?.workspaces;
  const directory = current?.directory;
  const match: WorkspaceMatch | undefined = useMemo(
    () => workspaces === undefined || directory === undefined
      ? undefined
      : matchWorkspace({ name: task.repo ?? null, directory }, workspaces),
    [workspaces, directory, task.repo],
  );
  return { workspaces, directory, match, error: current?.error ?? '' };
}

function ModelPicker({ capability, selection, onChange, disabled }: {
  capability: SessionCapability; selection?: ModelSelection; onChange(value?: ModelSelection): void; disabled: boolean;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!capability.catalog) return;
    const controller = new AbortController();
    setError('');
    void capability.catalog(controller.signal).then(
      value => { if (!controller.signal.aborted) setCatalog(value); },
      cause => { if (!controller.signal.aborted) setError(messageOf(cause)); },
    );
    return () => controller.abort();
  }, [capability, reload]);
  if (!capability.catalog || !capability.selectModel) return <p className="taskmd-muted">使用会话默认模型。</p>;
  if (error) return <p className="taskmd-error" role="alert">读取模型目录失败：{error} <button disabled={disabled} onClick={() => setReload(value => value + 1)}>重试读取模型目录</button></p>;
  if (!catalog) return <p className="taskmd-muted">正在读取模型目录…</p>;
  const selectedModel = catalog.groups.find(item => item.id === selection?.provider)?.models.find(item => item.id === selection?.model);
  const efforts = selectedModel?.reasoning?.efforts ?? [];
  return <div className="taskmd-model-picker">
    <label>模型<select value={selection ? `${selection.provider}\u0000${selection.model}` : ''} disabled={disabled} onChange={event => {
      const [provider, model] = event.target.value.split('\u0000');
      if (!provider || !model) { onChange(undefined); return; }
      const effort = catalog.groups.find(item => item.id === provider)?.models.find(item => item.id === model)?.reasoning?.defaultEffort;
      onChange({ provider, model, ...(effort ? { reasoningEffort: effort } : {}) });
    }}>
      <option value="">使用会话默认模型</option>
      {catalog.groups.map(group => <optgroup key={group.id} label={group.name}>
        {group.models.map(model => <option key={model.id} value={`${group.id}\u0000${model.id}`}>{model.name}</option>)}
      </optgroup>)}
    </select></label>
    {!!efforts.length && selection && <label>推理强度<select value={selection.reasoningEffort ?? ''} disabled={disabled} onChange={event => {
      onChange({ provider: selection.provider, model: selection.model, ...(event.target.value ? { reasoningEffort: event.target.value } : {}) });
    }}>
      <option value="">模型默认</option>
      {efforts.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
    </select></label>}
    {!!catalog.failures.length && <p className="taskmd-muted">部分模型目录不可用：{catalog.failures.map(item => `${item.name}（${item.message}）`).join('；')}</p>}
    {selection && <p className="taskmd-muted">所选模型也会成为 DSH 后续会话的默认模型。</p>}
  </div>;
}

interface LaunchProgress {
  sessionId?: string;
  bound: boolean;
  modelApplied: boolean;
  sent: boolean;
  opened: boolean;
  attachFailed?: boolean;
  /** Freeze both identity and content before the first send, including a lost acknowledgement. */
  delivery?: { requestId: string; text: string };
}
const freshProgress = (): LaunchProgress => ({ bound: false, modelApplied: false, sent: false, opened: false });

/** Task identity owns the form and all retry state. */
export function TaskSessionLauncher(props: { task: Task; capability: SessionCapability }) {
  return <SessionLaunchForm key={props.task.id} {...props} />;
}

function SessionLaunchForm({ task, capability }: { task: Task; capability: SessionCapability }) {
  const { workspaces, directory, match, error: loadError } = useWorkspaceTarget(task, capability);
  const [chosen, setChosen] = useState('');
  const [manual, setManual] = useState('');
  const [targetOwner, setTargetOwner] = useState({ id: task.id, repo: task.repo });
  if (targetOwner.id !== task.id || targetOwner.repo !== task.repo) {
    setTargetOwner({ id: task.id, repo: task.repo });
    setChosen(''); setManual('');
  }
  const [preset, setPreset] = useState('');
  const [selection, setSelection] = useState<ModelSelection>();
  const [prompt, setPrompt] = useState(() => initialPrompt(task));
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState<Failure>();
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const locked = useRef(false);
  const progress = useRef<LaunchProgress>(freshProgress());
  const current = progress.current;
  const auto = match?.kind === 'matched' ? match.workspace : undefined;
  const target = useMemo(() => resolveTarget({ manual, chosen, match, workspaces, directory }), [manual, chosen, match, workspaces, directory]);
  const canRun = !busy && !current.attachFailed && (!!current.sessionId || !!target)
    && (!capability.send || !!prompt.trim()) && !failure?.existingTaskId;
  const complete = current.opened && (!capability.send || current.sent);

  const run = async (agentPreset = preset, transferFrom?: string) => {
    if (locked.current || current.attachFailed || (!current.sessionId && !target) || (capability.send && !prompt.trim())) return;
    if (failure?.existingTaskId && !transferFrom) return;
    locked.current = true; setBusy(true); setFailure(undefined); setNotice('');
    let stage = '创建并绑定会话';
    const step = (label: string) => { stage = label; setPhase(label); };
    try {
      if (!current.sessionId) {
        step('创建并绑定会话');
        const result = await capability.create(task.id, createOptions(target!, agentPreset));
        current.sessionId = result.sessionId;
        current.bound = true;
      }
      const id = current.sessionId;
      if (!current.bound) {
        step('绑定会话');
        if (transferFrom) await capability.unbind(transferFrom, id);
        await capability.bind(task.id, id);
        current.bound = true;
      }
      if (!current.modelApplied) {
        step('设置模型');
        if (selection) {
          if (!capability.selectModel) throw new Error('此环境无法设置模型。');
          await capability.selectModel(id, selection);
        }
        current.modelApplied = true;
      }
      if (capability.send && !current.sent) {
        step('发送首条消息');
        current.delivery ??= { requestId: crypto.randomUUID(), text: prompt };
        await capability.send(id, current.delivery.text, current.delivery.requestId);
        current.sent = true;
      }
      if (!current.opened) {
        step('打开会话');
        await capability.open(id);
        current.opened = true;
      }
      setNotice(current.sent ? '首条消息已发送，会话已打开。' : '会话已创建并打开，请复制提示词后手动发送。');
    } catch (cause) {
      const described = describeFailure(cause);
      if (!current.sessionId && described.sessionId) current.sessionId = described.sessionId;
      if (described.code === 'session_attach_failed') current.attachFailed = true;
      setFailure({ ...described, message: `${stage}失败：${described.message}`, sessionId: current.sessionId });
    } finally { locked.current = false; setBusy(false); setPhase(''); }
  };

  const open = async () => {
    if (locked.current || !current.sessionId) return;
    locked.current = true; setBusy(true);
    try { await capability.open(current.sessionId); }
    catch (cause) { setNotice(`打开会话失败：${messageOf(cause)}`); }
    finally { locked.current = false; setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setNotice('已复制提示词。'); }
    catch { setNotice('浏览器拒绝了剪贴板访问，请手动选中文本复制。'); }
  };
  const candidates = match?.kind === 'candidates' ? match.list : [];
  const frozen = busy || !!current.delivery;
  return <details className="taskmd-box taskmd-launcher" aria-label="从任务新建会话"><summary>从任务新建会话</summary>
    {loadError && <p className="taskmd-error" role="alert">{loadError}</p>}
    <fieldset className="taskmd-launch-options" disabled={busy || !!current.sessionId}>
      {!task.repo && <p className="taskmd-muted">请选择工作目录。</p>}
      {!!candidates.length && <label>选择 Workspace<select value={chosen} onChange={event => setChosen(event.target.value)}>
        <option value="">请选择一个（{candidates.length} 个候选）</option>
        {candidates.map(item => <option key={item.workspaceId} value={item.workspaceId}>{item.title} · {item.path}</option>)}
      </select></label>}
      {auto && !manual.trim() && <p className="taskmd-muted">Workspace：{auto.title}（{auto.path}）</p>}
      <label>改用其他工作目录<input value={manual} onChange={event => setManual(event.target.value)} placeholder="可选；填写后覆盖 Workspace 选择" /></label>
      <label>Agent preset<input value={preset} onChange={event => setPreset(event.target.value)} placeholder="可选；留空使用默认 preset" /></label>
    </fieldset>
    <ModelPicker capability={capability} selection={selection} disabled={frozen} onChange={value => { setSelection(value); current.modelApplied = false; }} />
    <label>初始化提示词<textarea aria-label="初始化提示词" spellCheck={false} value={prompt} disabled={frozen} onChange={event => setPrompt(event.target.value)} /></label>
    <div className="taskmd-toolbar">
      <button disabled={busy || !prompt.trim()} onClick={() => { void copy(); }}>复制提示词</button>
      <button disabled={frozen} onClick={() => setPrompt(initialPrompt(task))}>恢复默认</button>
      <button disabled={frozen} onClick={() => setPrompt('')}>清空</button>
    </div>
    {!capability.send && <p className="taskmd-muted">此环境不支持直接发送消息，创建后请复制提示词到会话中发送。</p>}
    {failure && <div className="taskmd-error" role="alert">
      <p>{failure.message}</p>
      {current.sessionId && <p className="taskmd-muted">会话 {current.sessionId} 已创建；继续执行会复用这个会话。</p>}
      {current.attachFailed && <p>工作目录挂载失败，请打开会话处理；不会自动发送消息。</p>}
      {failure.existingTaskId && <button disabled={busy} onClick={() => { void run(preset, failure.existingTaskId); }}>解除原任务关联并继续</button>}
      {(failure.code === 'agent-preset/not-found' || failure.code === 'agent-preset/invalid') && !current.sessionId
        && <button disabled={busy} onClick={() => { setPreset(''); void run(''); }}>清空 preset 用默认值重试</button>}
    </div>}
    {!complete && <div className="taskmd-toolbar">
      <button disabled={!canRun} onClick={() => { void run(); }}>{busy ? `${phase}…` : current.sessionId ? '继续执行' : capability.send ? '创建并发送首条消息' : '创建并绑定会话'}</button>
      {target && !current.sessionId && <span className="taskmd-muted">工作目录：{target.label}</span>}
    </div>}
    {current.sessionId && <div className="taskmd-toolbar">
      <span className="taskmd-muted">会话：{current.sessionId}{current.bound ? ' · 已绑定' : ' · 未绑定'}</span>
      <button disabled={busy} onClick={() => { void open(); }}>打开会话</button>
      {complete && <button disabled={busy} onClick={() => { progress.current = freshProgress(); setFailure(undefined); setNotice(''); }}>再新建一个会话</button>}
    </div>}
    {notice && <p className="taskmd-muted" role="status">{notice}</p>}
  </details>;
}
