import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { State, TaskRecord } from '../types.js';
import type { SessionCapability, TaskPort } from './port.js';
import { initialPrompt } from './prompt.js';
import { failure } from './shared.js';

interface DraftSpan { start: number; end: number; draftRev: number }
export interface NativeDraftActions {
  captureInsertion(): DraftSpan;
  insertText(text: string, span: DraftSpan): boolean;
  persistDraft(): void;
}
interface NativeInputSnapshot {
  draft: string;
  phase: 'plain' | 'claimed' | 'adjudicating' | 'submitting' | 'sending';
}
export interface NativeTaskOptionProps {
  sessionId: string;
  useInput<T>(selector: (snapshot: NativeInputSnapshot) => T): T;
  inputActions: NativeDraftActions;
  port: TaskPort;
  sessions: SessionCapability;
}
export type NativeBindResult = 'inserted' | 'already-present' | 'draft-changed';

/**
 * The official New Session hero owns the Session and the composer.
 * Bind that *existing* blank Session, then insert into its unsent draft. A
 * revision-guarded edit cannot replace text the user typed while the Host was
 * saving the binding; neither a message nor another Session is created here.
 */
export async function bindNativeSessionTask(
  port: Pick<TaskPort, 'readTask'>,
  sessions: Pick<SessionCapability, 'list' | 'bind'>,
  actions: NativeDraftActions,
  sessionId: string,
  taskId: string,
  draft: string,
): Promise<NativeBindResult> {
  const span = actions.captureInsertion();
  const bindings = await sessions.list();
  const previous = bindings.find(item => item.sessionId === sessionId);
  if (previous && previous.taskId !== taskId) {
    throw new Error('当前 Session 已关联其他任务。请先在 taskmd 侧栏解除关联，再选择新任务。');
  }
  const record = await port.readTask(taskId);
  const alreadyPresent = draft.includes(`任务 ID：${record.task.id}`);
  await sessions.bind(record.task.id, sessionId);
  if (alreadyPresent) return 'already-present';
  // A selected range would be replaced by insertText. Never discard it.
  if (span.start !== span.end) return 'draft-changed';
  const prompt = initialPrompt(record);
  if (!actions.insertText(`${draft.trim() ? '\n\n' : ''}${prompt}`, span)) return 'draft-changed';
  actions.persistDraft();
  return 'inserted';
}

const css = `
.tm-native-trigger{display:inline-flex;align-items:center;gap:5px;max-width:200px;height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,CanvasText 15%,transparent));border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.tm-native-trigger span{overflow:hidden;text-overflow:ellipsis}
.tm-native-trigger:disabled{opacity:.5;cursor:default}
.tm-native-popover{position:fixed;z-index:10000;width:min(340px,calc(100vw - 16px));max-height:min(440px,80vh);overflow-y:auto;padding:12px;border:1px solid var(--dsw-alias-border-l1,color-mix(in srgb,CanvasText 15%,transparent));border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.24);background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font-size:13px;line-height:1.5}
.tm-native-popover button,.tm-native-popover input{font:inherit}
.tm-native-popover input{box-sizing:border-box;width:100%;min-height:32px;padding:5px 9px;border:1px solid rgba(127,127,127,.35);border-radius:7px;background:transparent;color:inherit}
.tm-native-popover button{cursor:pointer}
.tm-native-popover button:disabled{opacity:.5;cursor:default}
.tm-native-tabs{display:flex;gap:5px;margin:9px 0}
.tm-native-tabs button{flex:1;border:0;border-radius:7px;padding:6px;background:rgba(127,127,127,.08);color:inherit}
.tm-native-tabs button[aria-selected=true]{background:rgba(127,127,127,.19);font-weight:600}
.tm-native-list{max-height:205px;overflow-y:auto;margin-top:7px}
.tm-native-list button{display:block;width:100%;padding:7px 8px;text-align:left;border:0;border-radius:6px;background:transparent;color:inherit;overflow-wrap:anywhere}
.tm-native-list button:hover,.tm-native-list button:focus-visible{background:rgba(127,127,127,.12)}
.tm-native-muted{color:var(--dsw-alias-label-secondary,color-mix(in srgb,CanvasText 62%,transparent));font-size:12px}
.tm-native-popover p{margin:7px 0}
.tm-native-confirm{width:100%;padding:8px;border:0;border-radius:7px;background:var(--dsw-alias-brand-primary,#3778db);color:#fff;margin-top:9px}
.tm-native-error{color:#c54b49;white-space:pre-wrap}
`;

/** Optional, compact extension to DSH's own New Session row (not a replacement launcher). */
export function NativeSessionTaskOption({ sessionId, useInput, inputActions, port, sessions }: NativeTaskOptionProps) {
  const draft = useInput(snapshot => snapshot.draft);
  const phase = useInput(snapshot => snapshot.phase);
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const locked = useRef(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'existing' | 'new'>('existing');
  const [state, setState] = useState<State>();
  const [boundId, setBoundId] = useState('');
  const [linked, setLinked] = useState<TaskRecord>();
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [created, setCreated] = useState<TaskRecord>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    setOpen(false); setState(undefined); setBoundId(''); setLinked(undefined);
    setCreated(undefined); setError(''); setQuery(''); setTitle('');
  }, [sessionId]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    void Promise.all([port.getState(controller.signal), sessions.list(undefined, controller.signal)]).then(([next, bindings]) => {
      if (controller.signal.aborted) return;
      setState(next);
      setBoundId(bindings.find(item => item.sessionId === sessionId)?.taskId ?? '');
      setLoading(false);
    }, cause => {
      if (controller.signal.aborted) return;
      setLoading(false); setLoadError(failure(cause));
    });
    return () => controller.abort();
  }, [open, revision, sessionId, port, sessions]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(340, window.innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top: rect.bottom + 440 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - Math.min(440, window.innerHeight * .8) - 6),
      });
    };
    const outside = (event: PointerEvent) => {
      if (anchor.current?.contains(event.target as Node) || popup.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const attach = async (record?: TaskRecord) => {
    if (locked.current || phase !== 'plain') return;
    locked.current = true; setBusy(true); setError('');
    try {
      let task = record;
      if (!task) {
        if (!title.trim()) throw new Error('请输入任务标题。');
        task = await port.createTask({ title: title.trim() });
        // If binding fails, keep the already-created Task for an explicit retry.
        setCreated(task);
      }
      const result = await bindNativeSessionTask(port, sessions, inputActions, sessionId, task.task.id, draft);
      setBoundId(task.task.id); setLinked(task); setRevision(value => value + 1);
      if (result === 'draft-changed') {
        setError('会话已关联，但输入框内容或选区发生了变化。未覆盖原草稿。请清除选区后点击“重新填入 Prompt”。');
      } else {
        setCreated(undefined); setOpen(false);
      }
    } catch (cause) { setError(failure(cause)); }
    finally { locked.current = false; setBusy(false); }
  };

  const tasks = (state?.tasks ?? []).filter(item => !item.task.archived && (
    !query.trim() || `${item.task.title} ${item.task.summary ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  ));
  const bound = linked?.task.id === boundId ? linked : state?.tasks.find(item => item.task.id === boundId);
  const selected = bound && boundId ? bound : undefined;
  return <>
    <style>{css}</style>
    <button ref={anchor} type="button" className="tm-native-trigger" aria-label="选择或新建 taskmd 任务" aria-expanded={open} aria-controls={id}
      title={selected ? `已关联：${selected.task.title}` : '关联已有任务或新建任务'} onClick={() => setOpen(value => !value)}>
      <span>{selected ? `任务：${selected.task.title}` : boundId ? '已关联任务' : '＋ 任务'}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && typeof document !== 'undefined' && createPortal(<div ref={popup} id={id} role="dialog" aria-label="关联任务到新 Session"
      className="tm-native-popover" style={{ top: position.top, left: position.left }}>
      <strong>为当前 Session 关联任务</strong>
      <p className="tm-native-muted">关联后将任务 Prompt 填入输入框，不自动发送。已有草稿不会被覆盖。</p>
      {boundId && <p className="tm-native-muted">已关联：{selected?.task.title ?? boundId}</p>}
      <div role="tablist" aria-label="关联方式" className="tm-native-tabs">
        <button role="tab" aria-selected={tab === 'existing'} onClick={() => { setTab('existing'); setError(''); }}>选择已有任务</button>
        <button role="tab" aria-selected={tab === 'new'} onClick={() => { setTab('new'); setError(''); }}>新建任务</button>
      </div>
      {tab === 'existing' ? <>
        <input type="search" aria-label="搜索任务" placeholder="搜索任务标题或摘要" value={query} onChange={event => setQuery(event.target.value)} />
        <div className="tm-native-list" role="group" aria-label="可关联任务">
          {tasks.slice(0, 25).map(record => <button key={record.task.id} type="button" disabled={busy || phase !== 'plain' || (!!boundId && boundId !== record.task.id)}
            onClick={() => void attach(record)} title={record.task.summary}>{record.task.title}{record.task.id === boundId ? ' · 已关联' : ''}</button>)}
          {!loading && !tasks.length && <p className="tm-native-muted">没有可选任务。</p>}
          {tasks.length > 25 && <p className="tm-native-muted">还有 {tasks.length - 25} 项，请缩小搜索范围。</p>}
        </div>
      </> : <>
        <label htmlFor={`${id}-title`}>任务标题</label>
        <input id={`${id}-title`} value={title} maxLength={180} placeholder="例如：优化登录流程" onChange={event => setTitle(event.target.value)} />
        <p className="tm-native-muted">任务 Markdown 创建在 taskmd Home；会使用该版本的默认正文模板。</p>
        {created && <p className="tm-native-muted">已创建：{created.task.title}。可以继续关联，无需重复创建。</p>}
        <button className="tm-native-confirm" type="button" disabled={busy || phase !== 'plain' || (!created && (!title.trim() || !state)) || (!!boundId && boundId !== created?.task.id)}
          onClick={() => void attach(created)}>{busy ? '处理中…' : created ? '继续关联已创建的任务' : '创建任务并关联'}</button>
      </>}
      {boundId && selected && <button className="tm-native-confirm" type="button" disabled={busy || phase !== 'plain'}
        onClick={() => void attach(selected)}>重新填入 Prompt</button>}
      {loading && <p className="tm-native-muted">正在读取任务…</p>}
      {loadError && <p role="alert" className="tm-native-error">{loadError} <button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></p>}
      {error && <p role="alert" className="tm-native-error">{error}</p>}
      {boundId && <p className="tm-native-muted">更换关联任务前，请到 taskmd 侧栏解除现有关联。</p>}
    </div>, document.body)}
  </>;
}
