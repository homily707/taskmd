import { useEffect, useId, useRef, useState } from 'react';
import type { TaskRecord } from '../types.js';
import type { TaskPort } from './port.js';
import { MarkdownPreview } from './markdown-preview.js';
import { draftKey, isVersionConflict, readDraft, storeLocal, subscribeLocal, type BodyDraft } from './task-editing.js';
import { failure } from './shared.js';

export function useBodyDraft(record: TaskRecord, port: TaskPort, onChanged: () => Promise<void>) {
  const [draft, setDraft] = useState(() => readDraft(record));
  const current = useRef(draft);
  const [latest, setLatest] = useState(record);
  const latestRef = useRef(record);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  useEffect(() => { setLatest(record); latestRef.current = record; }, [record]);
  useEffect(() => subscribeLocal(draftKey(record), () => {
    const next = readDraft(record); current.current = next; setDraft(next);
  }), [record.task.id]);
  const persist = (value?: BodyDraft) => {
    current.current = value; setDraft(value);
    setStorageWarning(!storeLocal(draftKey(record), value));
  };
  const dirty = !!draft;
  const conflict = !!draft && latest.task.body !== draft.baseBody && latest.version !== draft.version;
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  const change = (body: string) => {
    const base = current.current ?? { body: latestRef.current.task.body, baseBody: latestRef.current.task.body, version: latestRef.current.version };
    const changedBase = latestRef.current.task.body !== base.baseBody;
    persist(!locked.current && !changedBase && body === base.baseBody ? undefined : { ...base, body });
  };
  const save = async (): Promise<TaskRecord> => {
    if (locked.current) throw new Error('正文正在保存，请稍后重试。');
    const snapshot = current.current;
    if (!snapshot) return latestRef.current;
    const base = latestRef.current;
    if (base.task.body !== snapshot.baseBody && base.version !== snapshot.version) throw new Error('正文已被外部修改，请先核对冲突；草稿已保留。');
    locked.current = true; setBusy(true); setError('');
    try {
      const saved = await port.updateTask(record.task.id, { body: snapshot.body }, base.version);
      latestRef.current = saved; setLatest(saved);
      const pending = readDraft(record);
      if (pending?.body === snapshot.body) persist(undefined);
      else if (pending) persist({ ...pending, baseBody: saved.task.body, version: saved.version });
      await onChanged(); return saved;
    } catch (cause) {
      setError(failure(cause));
      if (isVersionConflict(cause)) {
        try { const next = await port.readTask(record.task.id); latestRef.current = next; setLatest(next); } catch { /* Keep the last known base and draft. */ }
      }
      throw cause;
    } finally { locked.current = false; setBusy(false); }
  };
  return { body: draft?.body ?? latest.task.body, dirty, conflict, busy, error, storageWarning, latest, change, save,
    rebase: () => { if (current.current) persist({ ...current.current, baseBody: latest.task.body, version: latest.version }); setError(''); },
    discard: () => { persist(undefined); setError(''); },
  };
}
export function TaskEditor({ editor, port, record }: { editor: ReturnType<typeof useBodyDraft>; port: TaskPort; record: TaskRecord }) {
  const [editing, setEditing] = useState(editor.dirty);
  const id = useId();
  return <section className="taskmd-body" aria-label="任务正文">
    <div className="taskmd-toolbar"><button aria-pressed={!editing} onClick={() => setEditing(false)}>阅读</button><button aria-pressed={editing} onClick={() => setEditing(true)}>编辑正文</button>
      {editor.dirty && <button disabled={editor.busy || editor.conflict} onClick={() => void editor.save().catch(() => {})}>保存正文</button>}
      <span className="taskmd-muted" role="status">{editor.busy ? '正在保存…' : editor.dirty ? '草稿未保存' : '已保存'}</span>
    </div>
    {editor.storageWarning && editor.dirty && <p className="taskmd-muted">草稿暂存在当前页面内存中；关闭页面前请保存。</p>}
    {editor.error && <p role="alert" className="taskmd-error">{editor.error}</p>}
    {editor.conflict && <div className="taskmd-conflict" role="alert">
      <p>文件正文已变化。你的草稿保留在下方，请核对最新正文并合并后保存。</p>
      <details><summary>查看磁盘上的最新正文</summary><pre tabIndex={0} aria-label="最新正文">{editor.latest.task.body}</pre></details>
      <button onClick={editor.rebase}>已核对，以最新版本为基础保留草稿</button>
    </div>}
    {editing ? <><label htmlFor={id}>Markdown 正文</label><textarea id={id} aria-label="Markdown 正文" value={editor.body} onChange={event => editor.change(event.target.value)} spellCheck={false} /></>
      : <MarkdownPreview text={editor.body} taskId={record.task.id} port={port} />}
    {editor.dirty && <details><summary>草稿操作</summary><button disabled={editor.busy} onClick={editor.discard}>丢弃草稿，使用已保存正文</button></details>}
  </section>;
}
