import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { State, TaskRecord } from '../types.js';
import type { TaskGraphPort } from './port.js';
import {
  bodyDiff, confirmDiscard, copyText, isVersionConflict, latestTask, loadDraft, storeDraft, taskFailure, taskPatch,
} from './task-editing.js';

/** A body-only draft: `baseBody`/`version`/`revision` are the state it was typed against. */
type Draft = { body: string; baseBody: string; version: string; revision: string };
type SurfaceComponent = ComponentType<{ documentId: string; body: string; onChange(body: string): void }>;

const draftKey = (id: string) => `taskmd:body-draft:${id}`;

function readDraft(id: string): Draft | undefined {
  const value = loadDraft(draftKey(id)) as Record<string, unknown> | null;
  if (value && ['body', 'baseBody', 'version', 'revision'].every(key => typeof value[key] === 'string')) {
    return value as Draft;
  }
}

export interface TaskEditorProps {
  record: TaskRecord;
  port: TaskGraphPort;
  state: State;
  onChanged(): Promise<void>;
  onDirty(dirty: boolean): void;
}

/** Keyed by Task: a pending read can never replace another task's draft. */
export function TaskEditor(props: TaskEditorProps) {
  return <BodyEditor key={props.record.task.id} {...props} />;
}

function BodyEditor({ record, port, state, onChanged, onDirty }: TaskEditorProps) {
  const id = record.task.id;
  const [draft, setDraft] = useState(() => readDraft(id));
  const [latest, setLatest] = useState({ record, revision: state.revision });
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [source, setSource] = useState(false);
  const [Surface, setSurface] = useState<SurfaceComponent>();
  // Bumped only when the mounted CodeMirror document must be re-seeded (load,
  // discard, save, external change). The Atomic surface reads `markdownSource`
  // once at mount, so replacing the document means remounting the view.
  const [generation, setGeneration] = useState(0);
  const seeded = useRef(draft?.body ?? record.task.body);
  const active = useRef(true);
  const locked = useRef(false);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const dirty = draft !== undefined;

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    // The Atomic surface imports its package CSS, which the bundler inlines as
    // text. Environments that cannot load it (tests, non-bundled hosts) keep
    // working through the Markdown source textarea.
    if (typeof document === 'undefined') return;
    let canceled = false;
    void import('./task-markdown-surface.js')
      .then(module => { if (!canceled) setSurface(() => module.default); })
      .catch(() => { if (!canceled) setNotice('Atomic 编辑器加载失败，已改用 Markdown 源码编辑。'); });
    return () => { canceled = true; };
  }, []);
  useEffect(() => { setLatest({ record, revision: state.revision }); }, [record, state.revision]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);

  const persist = (value?: Draft) => {
    setDraft(value);
    setStorageError(!storeDraft(draftKey(id), value));
  };

  const changed = !!draft && draft.version !== latest.record.version;
  const needsMerge = conflict || changed;
  const body = draft?.body ?? latest.record.task.body;

  // A concurrent save that left the body alone (title, status, dependencies)
  // cannot conflict with a body draft: rebase the draft's base instead of
  // forcing the user through conflict recovery.
  useEffect(() => {
    if (!draft || conflict || draft.version === latest.record.version) return;
    if (latest.record.task.body !== draft.baseBody) return;
    persist({ ...draft, baseBody: latest.record.task.body, version: latest.record.version, revision: latest.revision });
  }, [draft, latest, conflict]);

  // Typing stays possible while a save is in flight: the submitted text is
  // captured up front, and anything typed afterwards becomes a new draft on top
  // of the version just written instead of being silently dropped.
  const edit = (value: string) => {
    const base = draft ?? {
      body, baseBody: latest.record.task.body, version: latest.record.version, revision: latest.revision,
    };
    // A stale draft stays explicit even when the text happens to match its base.
    persist(needsMerge || value !== base.baseBody ? { ...base, body: value } : undefined);
    setNotice('');
  };
  const save = async (merged = false) => {
    if (!draft || locked.current || (needsMerge && !merged)) return;
    // Merging takes the latest version as the new base; the user already
    // reconciled the text in the editor.
    const submitted = merged
      ? { ...draft, baseBody: latest.record.task.body, version: latest.record.version, revision: latest.revision }
      : draft;
    if (merged) persist(submitted);
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      // Body-only patch: the Store rewrites just the body, so frontmatter
      // comments and unknown fields stay byte-identical.
      const result = await port.apply(taskPatch({ id, version: submitted.version }, submitted.revision, { body: submitted.body }));
      try {
        // Only this exact submitted draft is discarded, and only after success.
        const stored = readDraft(id);
        if (stored?.body === submitted.body && stored.version === submitted.version) storeDraft(draftKey(id), undefined);
      } catch { /* Reported by persist while mounted. */ }
      if (!active.current) return;
      const version = result.versions[id] ?? submitted.version;
      setLatest({
        record: { ...latest.record, task: { ...latest.record.task, body: submitted.body }, version },
        revision: result.revision,
      });
      seeded.current = submitted.body;
      const newer = currentDraft.current;
      if (newer && newer.body !== submitted.body) {
        // Typed while the request was in flight: keep that text as a draft on
        // top of the version just written instead of dropping it.
        persist({ ...newer, baseBody: submitted.body, version, revision: result.revision });
        setConflict(false); setNotice('正文已保存；保存期间的新输入仍未保存。');
      } else {
        persist(undefined); setConflict(false); setNotice('正文已保存。'); setGeneration(value => value + 1);
      }
      try { await onChanged(); } catch (failure) { if (active.current) setError(`正文已保存，但刷新失败：${taskFailure(failure)}`); }
    } catch (failure) {
      if (!active.current) return;
      setError(taskFailure(failure));
      if (isVersionConflict(failure)) {
        setConflict(true);
        try { const next = await latestTask(port, id); if (active.current) setLatest(next); }
        catch (readFailure) { if (active.current) setError(`${taskFailure(failure)}\n读取最新版本失败：${taskFailure(readFailure)}`); }
      }
    } finally { locked.current = false; if (active.current) setBusy(false); }
  };

  const refresh = async (discard: boolean) => {
    if (locked.current) return;
    if (discard && dirty && !confirmDiscard('丢弃本地正文草稿并加载最新正文？建议先复制草稿。')) return;
    const before = currentDraft.current;
    locked.current = true; setBusy(true); setError('');
    try {
      const next = await latestTask(port, id);
      if (!active.current) return;
      setLatest(next);
      if (!discard) return;
      const after = currentDraft.current;
      if (after && after.body !== before?.body) {
        // Typed during the read: the newer text is a draft, not something to drop.
        persist({ ...after, baseBody: next.record.task.body, version: next.record.version, revision: next.revision });
        setNotice('已加载最新正文；读取期间的新输入仍未保存。');
        return;
      }
      persist(undefined); setConflict(false); setNotice('已加载最新正文。'); setGeneration(value => value + 1);
    } catch (failure) { if (active.current) setError(taskFailure(failure)); }
    finally { locked.current = false; if (active.current) setBusy(false); }
  };

  const copy = () => {
    void copyText(body).then(() => setNotice('已复制正文草稿。'))
      .catch(() => setError('复制失败，请切换源码模式后手动复制正文。'));
  };

  return <section className="taskmd-box taskmd-editor" aria-label="正文编辑">
    <div className="taskmd-toolbar"><h4>Markdown 正文</h4>
      <button type="button" disabled={busy} aria-pressed={source} onClick={() => setSource(!source)}>源码模式</button></div>
    <p className="taskmd-muted">仅编辑正文；标题、状态与关系在属性面板保存。保存只改正文，frontmatter 的注释与未知字段原样保留。</p>
    {Surface && !source
      ? <Surface documentId={`${id}:${generation}`} body={body} onChange={edit} />
      : <textarea aria-label="任务正文 Markdown" spellCheck={false} value={body} onChange={event => edit(event.target.value)} />}
    {dirty && <p role="status" className="taskmd-muted">正文尚未保存；草稿保存在本会话，切换任务后回来仍可继续。</p>}
    {storageError && <p role="alert" className="taskmd-error">浏览器草稿存储不可用，离开前请复制正文。</p>}
    {error && <pre role="alert" className="taskmd-error">{error}</pre>}
    {notice && <p role="status">{notice}</p>}
    {needsMerge && draft && <section className="taskmd-box taskmd-conflict" aria-label="正文冲突恢复">
      <h4>版本已变化，本地草稿已保留</h4>
      <p>下面是磁盘上的最新正文与本地草稿的差异。把需要的内容合并进编辑器后，再点“已人工合并”用最新版本重试；不会自动覆盖。</p>
      <pre aria-label="最新正文与本地草稿差异">{bodyDiff(latest.record.task.body, draft.body)}</pre>
      <details><summary>查看最新正文</summary><pre>{latest.record.task.body}</pre></details>
      <p className="taskmd-muted">最新版本：{latest.record.version}</p>
      <div className="taskmd-toolbar">
        <button type="button" disabled={busy} onClick={() => { void refresh(false); }}>刷新最新版本与差异</button>
        <button type="button" disabled={busy} onClick={copy}>复制本地草稿</button>
        <button type="button" disabled={busy} onClick={() => { void save(true); }}>已人工合并，使用最新版本重试</button>
      </div>
    </section>}
    <div className="taskmd-toolbar">
      <button type="button" disabled={busy || !dirty || needsMerge} onClick={() => { void save(); }}>保存正文</button>
      <button type="button" disabled={busy} onClick={() => { void refresh(true); }}>加载最新正文</button>
      <button type="button" disabled={busy} onClick={copy}>复制正文草稿</button>
      <button type="button" disabled={busy || !dirty} onClick={() => {
        if (confirmDiscard('放弃本地正文草稿？')) { persist(undefined); setConflict(false); setError(''); setNotice('已放弃正文草稿。'); }
      }}>放弃草稿</button>
    </div>
  </section>;
}
