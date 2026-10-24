import { useEffect, useRef, useState } from 'react';
import type { AssetRef, State, TaskRecord } from '../types.js';
import type { TaskGraphPort } from './port.js';
import { failure } from './shared.js';

function AssetRow({ taskId, asset, index, port, removing, onRemove }: {
  taskId: string; asset: AssetRef; index: number; port: TaskGraphPort; removing: boolean; onRemove(index: number): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);
  const read = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try {
      const result = await port.readAsset(taskId, index, controller.signal);
      if (!controller.signal.aborted) {
        if (result.path !== asset.path) throw new Error('资源引用已变化，请刷新任务后重试。');
        setContent(result.content);
      }
    } catch (cause) { if (!controller.signal.aborted) setError(failure(cause)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  };
  const toggle = () => {
    if (expanded) { request.current?.abort(); setLoading(false); setExpanded(false); }
    else { setExpanded(true); void read(); }
  };
  const label = `${asset.kind === 'repo' ? asset.repo : 'shared'}:${asset.path}`;
  return <div className="taskmd-asset-row">
    <div className="taskmd-asset-heading">
      <button className="taskmd-asset-toggle" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'} ${label}`} onClick={toggle}>
        <span aria-hidden="true">{expanded ? '▾' : '▸'} </span>{label}
      </button>
      <button disabled={removing} onClick={() => setConfirmRemove(true)}>解除关联</button>
    </div>
    {confirmRemove && <div role="group" aria-label={`解除 ${label} 的关联`}>
      <p className="taskmd-muted">仅移除当前任务对该资源的引用，实际文件会保留。</p>
      <div className="taskmd-toolbar"><button disabled={removing} onClick={() => { void onRemove(index).then(() => setConfirmRemove(false), () => {}); }}>确认解除</button>
        <button disabled={removing} onClick={() => setConfirmRemove(false)}>返回</button></div>
    </div>}
    {expanded && <div>
      {loading && <p className="taskmd-muted" role="status">正在读取资源…</p>}
      {error && <p className="taskmd-error" role="alert">{error} <button onClick={() => { void read(); }}>重试读取</button></p>}
      {!loading && !error && content !== undefined && <pre>{content}</pre>}
    </div>}
  </div>;
}

/** References belong to task metadata; unlinking never touches the underlying files. */
export function TaskAssets({ record, state, port, onChanged }: {
  record: TaskRecord; state: State; port: TaskGraphPort; onChanged(): Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const remove = async (index: number) => {
    if (locked.current) return;
    locked.current = true; setRemoving(true); setError('');
    try {
      await port.apply({ requestId: crypto.randomUUID(), baseRevision: state.revision, operations: [{
        op: 'patch', id: record.task.id, expectedVersion: record.version,
        changes: { assets: record.task.assets.filter((_, itemIndex) => itemIndex !== index) },
      }] });
      await onChanged();
    } catch (cause) { setError(failure(cause)); throw cause; }
    finally { locked.current = false; setRemoving(false); }
  };
  if (!record.task.assets.length) return null;
  return <details className="taskmd-box taskmd-assets" open><summary>资源引用（{record.task.assets.length}）</summary>
    {error && <p className="taskmd-error" role="alert">{error}</p>}
    {record.task.assets.map((asset, index) => <AssetRow key={`${record.task.id}:${record.version}:${index}`} taskId={record.task.id}
      asset={asset} index={index} port={port} removing={removing} onRemove={remove} />)}
  </details>;
}
