import { useEffect, useRef, useState } from 'react';
import type { State, Task, TaskChanges, TaskRecord, TaskStatus } from '../types.js';
import type { TaskGraphPort } from './port.js';
import { deletionBlockers, descendants } from '../core/graph.js';
import {
  confirmDiscard, isVersionConflict, latestTask, loadDraft, storeDraft, taskFailure, taskPatch,
} from './task-editing.js';

/** The structured frontmatter this panel owns; the Markdown body belongs to TaskEditor. */
type Properties = Pick<Task, 'title' | 'repo' | 'parent' | 'blocked_by' | 'status'>;
type PropertyDraft = { fields: Properties; base: Properties; version: string; revision: string };

const fieldsOf = ({ title, repo, parent, blocked_by, status }: Task): Properties =>
  ({ title, repo, parent, blocked_by: [...blocked_by], status });
const draftKey = (id: string) => `taskmd:properties-draft:${id}`;
const statuses: Record<TaskStatus, string> = { todo: '待办', in_progress: '进行中', done: '已完成', canceled: '已取消' };
const terminal: TaskStatus[] = ['done', 'canceled'];

function validFields(value: unknown): value is Properties {
  if (!value || typeof value !== 'object') return false;
  const fields = value as Properties;
  return typeof fields.title === 'string'
    && (fields.repo === null || typeof fields.repo === 'string')
    && (fields.parent === null || typeof fields.parent === 'string')
    && Array.isArray(fields.blocked_by) && fields.blocked_by.every(id => typeof id === 'string')
    && Object.hasOwn(statuses, fields.status);
}
function readDraft(id: string): PropertyDraft | undefined {
  const draft = loadDraft(draftKey(id)) as PropertyDraft | null;
  if (draft && typeof draft === 'object' && validFields(draft.fields) && validFields(draft.base)
    && typeof draft.version === 'string' && typeof draft.revision === 'string') return draft;
}

/** Only fields the user actually changed are sent, so unrelated concurrent edits survive. */
export function propertyChanges(base: Properties, fields: Properties): TaskChanges {
  const changes: TaskChanges = {};
  for (const key of ['title', 'repo', 'parent', 'status'] as const) {
    if (base[key] !== fields[key]) Object.assign(changes, { [key]: fields[key] });
  }
  if (JSON.stringify(base.blocked_by) !== JSON.stringify(fields.blocked_by)) changes.blocked_by = [...fields.blocked_by];
  return changes;
}

export interface TaskPropertiesProps {
  task: Task;
  record: TaskRecord;
  port: TaskGraphPort;
  state: State;
  onChanged(): Promise<void>;
  onSelect(id: string): void;
  /** Lets the host refuse navigation while properties are unsaved. */
  onDirty?(dirty: boolean): void;
  bodyDirty?: boolean;
}

export function TaskProperties(props: TaskPropertiesProps) {
  return <PropertiesEditor key={props.task.id} {...props} />;
}

function PropertiesEditor({ task, record, port, state, onChanged, onSelect, onDirty, bodyDirty = false }: TaskPropertiesProps) {
  const id = task.id;
  const [draft, setDraft] = useState(() => readDraft(id));
  const [action, setAction] = useState<'archive' | 'restore' | 'delete'>();
  const [latest, setLatest] = useState({ record, revision: state.revision });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [conflict, setConflict] = useState(false);
  const locked = useRef(false);
  // The version this panel itself last wrote. A draft must never be rebased
  // onto it: without this guard the auto-rebase effect resurrects a draft that
  // a successful save just cleared, flipping the panel back to dirty.
  const appliedVersion = useRef<string>();
  const active = useRef(true);
  const dirty = draft !== undefined || action !== undefined;
  const deleteBlockers = deletionBlockers(state.tasks, latest.record.task);
  const family = new Set([id, ...descendants(state.tasks, id)]);
  const canArchive = state.tasks.filter(item => family.has(item.id)).every(item => terminal.includes(item.status));
  const actionBlocked = bodyDirty || draft !== undefined
    || (action === 'delete' && !!deleteBlockers.length) || (action === 'archive' && !canArchive);

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setLatest({ record, revision: state.revision }); }, [record, state.revision]);
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false); }, [dirty, onDirty]);
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);

  const fields = draft?.fields ?? fieldsOf(latest.record.task);
  const changes = draft ? propertyChanges(draft.base, draft.fields) : {};

  /**
   * A newer version elsewhere is only a conflict when it touched a field this
   * draft also changes. Otherwise the draft is rebased onto the new version and
   * saved normally, so an unrelated edit elsewhere does not block this panel.
   */
  const touchedElsewhere = (source: PropertyDraft) => {
    const mine = propertyChanges(source.base, source.fields);
    const theirs = propertyChanges(source.base, fieldsOf(latest.record.task));
    return Object.keys(mine).some(key => {
      const field = key as keyof TaskChanges;
      return theirs[field] !== undefined && JSON.stringify(mine[field]) !== JSON.stringify(theirs[field]);
    });
  };
  const needsMerge = conflict || (!!draft && draft.version !== latest.record.version && touchedElsewhere(draft));
  const stale = needsMerge;

  const persist = (next?: PropertyDraft) => {
    setDraft(next);
    setStorageError(!storeDraft(draftKey(id), next));
  };

  // Same rule for a draft that was already open when the other version arrived.
  useEffect(() => {
    if (!draft || conflict || draft.version === latest.record.version) return;
    if (latest.record.version === appliedVersion.current) return;
    if (touchedElsewhere(draft)) return;
    persist({ ...draft, base: draft.base, version: latest.record.version, revision: latest.revision });
  }, [draft, latest, conflict]);

  const edit = (update: Partial<Properties>) => {
    setAction(undefined);
    const base = draft ?? { fields, base: fields, version: latest.record.version, revision: latest.revision };
    const next = { ...base, fields: { ...fields, ...update } };
    const changed = Object.keys(propertyChanges(next.base, next.fields)).length > 0;
    // A stale draft stays explicit even when the edited field is reverted.
    persist(changed || needsMerge ? next : undefined);
    setNotice('');
  };

  const save = async (rebase = false) => {
    if (action) {
      if (locked.current || actionBlocked) return;
      locked.current = true; setBusy(true); setError(''); setNotice('');
      try {
        await port.apply({ requestId: crypto.randomUUID(), baseRevision: latest.revision,
          operations: action === 'delete'
            ? [{ op: 'delete', id, expectedVersion: latest.record.version }]
            : [{ op: 'patch', id, changes: {}, expectedVersion: latest.record.version }, { op: action, id }],
        });
        if (!active.current) return;
        setAction(undefined);
        setNotice(action === 'delete' ? '任务已删除。' : action === 'archive' ? '任务已归档。' : '已取消归档，执行状态保持不变。');
        await onChanged();
      } catch (failure) { if (active.current) setError(taskFailure(failure)); }
      finally { locked.current = false; if (active.current) setBusy(false); }
      return;
    }
    if (!draft || locked.current || (needsMerge && !rebase)) return;
    // Retrying after a conflict sends only the fields this draft changed, so a
    // newer version of an untouched field is preserved.
    const submitted = rebase ? propertyChanges(draft.base, draft.fields) : changes;
    if (!Object.keys(submitted).length) { persist(undefined); return; }
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await port.apply(taskPatch(
        { id, version: rebase ? latest.record.version : draft.version },
        rebase ? latest.revision : draft.revision,
        submitted,
      ));
      try { storeDraft(draftKey(id), undefined); } catch { /* Retried by persist. */ }
      if (!active.current) return;
      const version = result.versions[id] ?? (rebase ? latest.record.version : draft.version);
      appliedVersion.current = version;
      setLatest({
        record: { ...latest.record, task: { ...latest.record.task, ...submitted } as Task, version },
        revision: result.revision,
      });
      persist(undefined); setConflict(false); setNotice('属性已保存。');
      try { await onChanged(); } catch (failure) { if (active.current) setError(`属性已保存，但刷新失败：${taskFailure(failure)}`); }
    } catch (failure) {
      if (!active.current) return;
      setError(taskFailure(failure));
      if (isVersionConflict(failure)) {
        setConflict(true);
        try { const next = await latestTask(port, id); if (active.current) setLatest(next); }
        catch (readFailure) { if (active.current) setError(`${taskFailure(failure)}\n读取最新属性失败：${taskFailure(readFailure)}`); }
      }
    } finally { locked.current = false; if (active.current) setBusy(false); }
  };

  // Direct dependencies may only point at siblings under the same direct parent;
  // the parent field itself is editable, and moving it re-scopes this list.
  const candidates = state.tasks.filter(candidate => candidate.id !== id && candidate.parent === fields.parent);
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  // Edges that are already invalid stay visible and selected: the user has to
  // remove them explicitly instead of losing them silently.
  const dependencyIds = [...new Set(fields.blocked_by)];
  const label = (target: string) => state.tasks.find(item => item.id === target)?.title || target;
  const missingParent = fields.parent !== null && !state.tasks.some(item => item.id === fields.parent && item.id !== id);
  const reopening = fields.status !== latest.record.task.status
    && terminal.includes(latest.record.task.status) && !terminal.includes(fields.status);
  const finishing = fields.status !== latest.record.task.status && fields.status === 'done';
  const submitLabel = action === 'delete' ? '确认永久删除' : action === 'archive' ? '确认归档' : action === 'restore' ? '确认取消归档' : finishing ? '明确完成并保存属性' : reopening ? '明确重新打开并保存属性' : '保存属性';

  return <details className="taskmd-box taskmd-properties" aria-label="任务属性">
    <summary>任务属性{dirty && <span className="taskmd-muted"> · 未保存</span>}</summary>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className="taskmd-property-fields" disabled={busy}>
        <label className="taskmd-property-row"><span>标题</span><input aria-label="任务标题" required value={fields.title} onChange={event => edit({ title: event.target.value })} /></label>
        <label className="taskmd-property-row"><span>仓库</span><input aria-label="仓库名称" value={fields.repo ?? ''} onChange={event => edit({ repo: event.target.value || null })} /></label>
        <label className="taskmd-property-row"><span>父任务</span><select aria-label="父任务" value={fields.parent ?? ''} onChange={event => edit({ parent: event.target.value || null })}>
          <option value="">根任务</option>
          {missingParent && <option value={fields.parent!}>原始无效关系：{fields.parent}</option>}
          {state.tasks.filter(item => item.id !== id).map(item => <option key={item.id} value={item.id}>{item.title}{item.archived ? '（已归档）' : ''}</option>)}
        </select></label>
        {fields.parent && <div className="taskmd-property-action"><button type="button" onClick={() => onSelect(fields.parent!)}>查看父任务</button></div>}
        <div className="taskmd-property-row" role="group" aria-label="直接依赖"><span>直接依赖</span><div>
          {!dependencyIds.length && <p className="taskmd-muted">暂无直接依赖。</p>}
          {dependencyIds.map(dependencyId => {
            const valid = candidateIds.has(dependencyId);
            return <div key={dependencyId}>
              <label><input type="checkbox" checked={fields.blocked_by.includes(dependencyId)} onChange={event => edit({
                blocked_by: event.target.checked
                  ? [...fields.blocked_by, dependencyId]
                  : fields.blocked_by.filter(value => value !== dependencyId),
              })} />{label(dependencyId)}{!valid && <span className="taskmd-error">（现有关系已失效：缺失、自依赖或与当前父任务不同；请明确移除或调整父任务）</span>}</label>
              <button type="button" onClick={() => onSelect(dependencyId)}>查看依赖任务</button>
            </div>;
          })}
          <select aria-label="添加依赖" value="" onChange={event => {
            if (event.target.value) edit({ blocked_by: [...fields.blocked_by, event.target.value] });
          }}>
            <option value="">添加依赖…</option>
            {candidates.filter(candidate => !fields.blocked_by.includes(candidate.id))
              .map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
          </select>
        </div></div>
        <div className="taskmd-property-row" role="group" aria-label="状态"><span>状态</span><div>
          <select aria-label="任务状态" value={action ?? (latest.record.task.archived ? 'archived' : fields.status)} onChange={event => {
            const value = event.target.value;
            if (value === 'archive' || value === 'restore' || value === 'delete') { setAction(value); setNotice(''); setError(''); }
            else edit({ status: value as TaskStatus });
          }}>
            {latest.record.task.archived && <option value="archived" disabled>已归档 · {statuses[latest.record.task.status]}</option>}
            {Object.entries(statuses).map(([value, text]) => <option key={value} value={value} disabled={latest.record.task.archived}>{text}（{value}）</option>)}
            <optgroup label="任务操作">
              {latest.record.task.archived
                ? <option value="restore" disabled={bodyDirty || !!draft}>取消归档</option>
                : <option value="archive" disabled={bodyDirty || !!draft || !canArchive}>归档任务</option>}
              <option value="delete" disabled={bodyDirty || !!draft || !!deleteBlockers.length}>删除任务</option>
            </optgroup>
          </select>
          <p className="taskmd-muted">取消会停止执行；归档会收起已结束的任务，保留完成或取消状态。取消父任务会取消未完成的后代；归档作用于整个子树。</p>
          {(bodyDirty || !!draft) && <p className="taskmd-muted">归档、取消归档或删除前，请先保存或放弃正文和属性草稿。</p>}
          {!latest.record.task.archived && !canArchive && <p className="taskmd-muted">归档前，本任务及全部子任务必须已完成或已取消。</p>}
          {!!deleteBlockers.length && <p className="taskmd-muted">暂不能删除：{deleteBlockers.map(item => item.message).join(' ')}</p>}
          {action === 'delete' && <p className="taskmd-error">永久删除「{task.title}」及其任务正文？点击「确认永久删除」后无法撤销。实际 Asset 文件和 DSH 会话会保留，本机任务会话关联会解除。</p>}
        </div></div>
        <p className="taskmd-muted">属性单独保存，不影响正文草稿。</p>
      </fieldset>
      {draft && <p role="status" className="taskmd-muted">属性尚未保存；草稿保存在本会话，切换任务后回来仍可继续。</p>}
      {storageError && <p role="alert" className="taskmd-error">浏览器无法保留属性草稿，请在离开前保存或手动记录。</p>}
      {error && <pre role="alert" className="taskmd-error">{error}</pre>}
      {notice && <p role="status">{notice}</p>}
      {stale && draft && <section className="taskmd-box taskmd-conflict" aria-label="属性冲突恢复">
        <h4>属性版本已变化，修改已保留</h4>
        <p>最新的属性里，有你也改过的字段。核对后重试：只会提交你改过的字段，其余字段保留最新值。</p>
        <pre aria-label="最新属性">{JSON.stringify(fieldsOf(latest.record.task), null, 2)}</pre>
        <pre aria-label="待提交属性修改">{JSON.stringify(changes, null, 2)}</pre>
        <button type="button" disabled={busy} onClick={() => { void save(true); }}>已核对，使用最新版本保存属性</button>
      </section>}
      <div className="taskmd-toolbar">
        <button className={action === 'delete' ? 'taskmd-danger' : undefined} disabled={busy || !dirty || !fields.title.trim() || stale || (!!action && actionBlocked)}>{submitLabel}</button>
        <button type="button" disabled={busy || !dirty} onClick={() => {
          if (!draft || confirmDiscard('放弃未保存的属性修改？正文草稿会保留。')) {
            persist(undefined); setAction(undefined); setConflict(false); setError(''); setNotice('已放弃属性修改。');
          }
        }}>{action ? '取消所选操作' : '放弃属性修改'}</button>
      </div>
    </form>
  </details>;
}
