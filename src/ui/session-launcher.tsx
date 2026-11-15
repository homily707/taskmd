import { useEffect, useId, useRef, useState } from 'react';
import type { HomeSettings, TaskRecord } from '../types.js';
import type { ModelCatalog, ModelSelection, SessionCapability } from './port.js';
import { failure, useWorkspaces } from './shared.js';
import { initialPrompt } from './prompt.js';
import { loadLocal, storeLocal } from './task-editing.js';

export interface LaunchProgress {
  requestId: string; text: string; workspaceId: string; preset: string; model?: ModelSelection;
  sessionId?: string; creating?: boolean; unknown?: boolean; bound?: boolean; modelApplied?: boolean; sent?: boolean; opened?: boolean;
}
const launchKey = (record: TaskRecord) => `taskmd:0.3:launch:${record.task.id}`;
const activeLaunches = new Set<string>();

/** Each acknowledged stage is persisted before continuing; send retries retain the request identity. */
export async function continueLaunch(capability: SessionCapability, taskId: string, progress: LaunchProgress, persist: () => void) {
  if (progress.unknown) throw new Error('创建结果不明。请在 DSH 会话列表核对，并关联已创建的 Session。');
  if (!progress.sessionId) {
    progress.creating = true; persist();
    try {
      const result = await capability.create(taskId, { workspaceId: progress.workspaceId, ...(progress.preset ? { agentPreset: progress.preset } : {}) });
      progress.sessionId = result.sessionId; progress.bound = true;
    } catch (cause) {
      const sessionId = (cause as { details?: { sessionId?: unknown } })?.details?.sessionId;
      if (typeof sessionId === 'string') progress.sessionId = sessionId;
      else progress.unknown = true;
      throw cause;
    } finally { progress.creating = false; persist(); }
  }
  const id = progress.sessionId;
  if (!progress.bound) { await capability.bind(taskId, id); progress.bound = true; persist(); }
  if (!progress.modelApplied) {
    if (progress.model) {
      if (!capability.selectModel) throw new Error('当前环境无法设置模型。');
      await capability.selectModel(id, progress.model);
    }
    progress.modelApplied = true; persist();
  }
  if (!progress.sent) {
    if (capability.send) await capability.send(id, progress.text, progress.requestId);
    progress.sent = true; persist();
  }
  if (!progress.opened) { await capability.open(id); progress.opened = true; persist(); }
}

export function TaskSessionLauncher({ record, settings, capability, save, onChanged }: {
  record: TaskRecord; settings: HomeSettings; capability: SessionCapability; save(): Promise<TaskRecord>; onChanged(): void;
}) {
  const workspaces = useWorkspaces(capability);
  const [chosen, setChosen] = useState(settings.homeWorkspaceId ?? '');
  const [preset, setPreset] = useState('');
  const [model, setModel] = useState<ModelSelection>();
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [catalogError, setCatalogError] = useState('');
  const [catalogTick, setCatalogTick] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [resumeId, setResumeId] = useState('');
  const locked = useRef(false);
  const progress = useRef<LaunchProgress | undefined>(loadLocal<LaunchProgress>(launchKey(record)));
  if (progress.current?.creating && !activeLaunches.has(launchKey(record))) { progress.current.creating = false; progress.current.unknown = true; }
  const ids = useId();
  useEffect(() => {
    const controller = new AbortController();
    void capability.catalog?.(controller.signal).then(value => { if (!controller.signal.aborted) { setCatalog(value); setCatalogError(''); } }, cause => { if (!controller.signal.aborted) setCatalogError(failure(cause)); });
    return () => controller.abort();
  }, [capability, catalogTick]);
  const persist = () => { storeLocal(launchKey(record), progress.current); setTick(value => value + 1); };
  const run = async () => {
    if (locked.current) return;
    const key = launchKey(record);
    if (activeLaunches.has(key)) { setError('此任务正在另一个面板准备会话，请稍后继续。'); return; }
    progress.current = loadLocal<LaunchProgress>(key) ?? progress.current;
    activeLaunches.add(key);
    locked.current = true; setBusy(true); setError('');
    try {
      if (!progress.current) {
        if (!chosen || !workspaces.items.some(item => item.workspaceId === chosen)) throw new Error('请选择一个可用的 DSH 仓库。');
        const saved = await save();
        progress.current = { requestId: crypto.randomUUID(), text: initialPrompt(saved), workspaceId: chosen, preset: preset.trim(), model };
        persist();
      }
      await continueLaunch(capability, record.task.id, progress.current, persist);
      onChanged();
    } catch (cause) { setError(failure(cause)); }
    finally { activeLaunches.delete(key); locked.current = false; setBusy(false); }
  };
  const current = progress.current;
  const complete = !!current?.opened;
  const selectedModel = catalog?.groups.find(group => group.id === model?.provider)?.models.find(item => item.id === model?.model);
  return <details className="taskmd-launcher"><summary>新建 Session</summary>
    <p className="taskmd-muted">保存正文后发送任务快照。默认在 Home 创建会话，也可选择其他仓库。</p>
    <fieldset disabled={busy || !!current}><legend>会话选项</legend>
      <label htmlFor={`${ids}-repo`}>Session 仓库</label><select id={`${ids}-repo`} aria-label="Session 仓库" value={chosen} onChange={event => setChosen(event.target.value)}>
        <option value="">选择 DSH 仓库</option>{workspaces.items.map(item => <option key={item.workspaceId} value={item.workspaceId}>{item.workspaceId === settings.homeWorkspaceId ? 'Home · ' : ''}{item.title} · {item.path}</option>)}
      </select>
      <label htmlFor={`${ids}-preset`}>Agent preset（可选）</label><input id={`${ids}-preset`} value={preset} onChange={event => setPreset(event.target.value)} placeholder="使用 DSH 默认 preset" />
      {capability.catalog && capability.selectModel && <><label htmlFor={`${ids}-model`}>模型</label><select id={`${ids}-model`} value={model ? JSON.stringify([model.provider, model.model]) : ''} onChange={event => {
        if (!event.target.value) { setModel(undefined); return; }
        const [provider, value] = JSON.parse(event.target.value) as [string, string];
        setModel({ provider, model: value });
      }}><option value="">DSH 默认模型</option>{catalog?.groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(item => <option key={item.id} value={JSON.stringify([group.id, item.id])}>{item.name}</option>)}</optgroup>)}</select></>}
      {!!selectedModel?.reasoning?.efforts.length && model && <><label htmlFor={`${ids}-effort`}>推理强度</label><select id={`${ids}-effort`} value={model.reasoningEffort ?? ''} onChange={event => setModel({ ...model, reasoningEffort: event.target.value || undefined })}><option value="">模型默认</option>{selectedModel.reasoning.efforts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></>}
    </fieldset>
    {workspaces.error && <p role="alert">{workspaces.error} <button onClick={workspaces.refresh}>重新读取仓库</button></p>}
    {catalogError && <p role="alert">{catalogError} <button onClick={() => setCatalogTick(value => value + 1)}>重新读取模型</button></p>}
    {!!catalog?.failures.length && <p className="taskmd-muted">部分模型不可用：{catalog.failures.map(item => item.name).join('、')}</p>}
    {error && <p role="alert" className="taskmd-error">{error}</p>}
    {current?.unknown ? <div><p>创建结果不明，已暂停重建。请先查看 DSH 会话列表，找到会话后填写 Session ID 继续。</p>
      <label htmlFor={`${ids}-resume`}>已创建的 Session ID</label><input id={`${ids}-resume`} value={resumeId} onChange={event => setResumeId(event.target.value)} />
      <button disabled={busy || !resumeId.trim()} onClick={() => { current.sessionId = resumeId.trim(); current.unknown = false; persist(); void run(); }}>关联并继续</button>
    </div> : <button disabled={busy || (!current && !chosen) || complete} onClick={() => void run()}>{busy ? '正在准备会话…' : complete ? '已发送并打开 Session' : current ? '继续上次启动' : '保存并启动 Session'}</button>}
    {current?.sessionId && <p className="taskmd-muted">Session：{current.sessionId} · {current.sent ? '已发送快照' : '尚未确认发送'}</p>}
    {complete && <button onClick={() => { progress.current = undefined; persist(); setError(''); }}>准备另一个 Session</button>}
  </details>;
}
