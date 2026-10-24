import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { generateKeyBetween } from 'fractional-indexing';
import { Document, isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { TaskError, type AssetRef, type Diagnostic, type Task } from '../types.js';

const MAX_BYTES = 1024 * 1024;
const FIELDS = new Set([
  'schema', 'id', 'title', 'status', 'parent', 'blocked_by',
  'order', 'repo', 'assets', 'archived',
]);
const STATUSES = new Set(['todo', 'in_progress', 'done', 'canceled']);

function invalid(message: string, details?: unknown): never {
  throw new TaskError('INVALID_DOCUMENT', message, 'Correct the task frontmatter and retry.', details);
}

function checkSize(content: string): void {
  if (typeof content !== 'string') invalid('Task content must be a string.');
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    throw new TaskError('DOCUMENT_TOO_LARGE', 'Task documents must not exceed 1 MiB.', 'Reduce the document size.');
  }
}

export function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new TaskError('INVALID_ID', 'IDs must start with an ASCII letter or digit and contain only ASCII letters, digits, hyphens, and underscores.', 'Use an ID such as task-123.');
  }
}

function splitDocument(content: string) {
  checkSize(content);
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(content);
  if (!opening) invalid('Task documents must begin with YAML frontmatter delimited by --- lines.');
  const closingPattern = /^---[ \t]*(?:\r?\n|$)/gm;
  closingPattern.lastIndex = opening[0].length;
  const closing = closingPattern.exec(content);
  if (!closing) invalid('Task frontmatter is missing its closing --- line.');
  const bodyOffset = closing.index + closing[0].length;
  return {
    opening: opening[0],
    yaml: content.slice(opening[0].length, closing.index),
    closing: closing[0],
    prefix: content.slice(0, bodyOffset),
    body: content.slice(bodyOffset),
    newline: opening[0].endsWith('\r\n') ? '\r\n' : '\n',
  };
}

// Read the AST directly: aliases are never expanded and mappings have no prototype.
function decode(node: unknown, depth = 0): unknown {
  if (depth > 100) invalid('YAML nesting exceeds the supported depth of 100.');
  if (node === null || node === undefined) return null;
  if (isAlias(node)) invalid('YAML aliases are not supported in task frontmatter.');
  if (isScalar(node)) {
    if (node.tag && !['tag:yaml.org,2002:str', 'tag:yaml.org,2002:null', 'tag:yaml.org,2002:bool', 'tag:yaml.org,2002:int', 'tag:yaml.org,2002:float'].includes(node.tag)) {
      invalid(`Unsupported YAML tag: ${node.tag}.`);
    }
    return node.value;
  }
  if (isSeq(node)) {
    if (node.tag && node.tag !== 'tag:yaml.org,2002:seq') invalid(`Unsupported YAML tag: ${node.tag}.`);
    return node.items.map((item) => decode(item, depth + 1));
  }
  if (isMap(node)) {
    if (node.tag && node.tag !== 'tag:yaml.org,2002:map') invalid(`Unsupported YAML tag: ${node.tag}.`);
    const result: Record<string, unknown> = Object.create(null);
    for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') invalid('YAML mapping keys must be strings.');
      const key = pair.key.value;
      if (Object.hasOwn(result, key)) invalid(`Duplicate YAML key: ${key}.`);
      result[key] = decode(pair.value, depth + 1);
    }
    return result;
  }
  invalid('Unsupported YAML node in task frontmatter.');
}

function stringField(value: unknown, name: string, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && !value.trim())) {
    invalid(`${name} must be ${nonempty ? 'a nonempty' : 'a'} string.`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : stringField(value, name, true);
}

function parseAssets(value: unknown): AssetRef[] {
  if (!Array.isArray(value)) invalid('assets must be an array.');
  return value.map((item: unknown, index): AssetRef => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid(`assets[${index}] must be a mapping.`);
    const asset = item as Record<string, unknown>;
    const path = stringField(asset.path, `assets[${index}].path`, true);
    if (/^[\\/]/.test(path) || /^[A-Za-z]:/.test(path) || path.includes('\0') || path.split(/[\\/]/).includes('..')) {
      invalid(`assets[${index}].path must be relative and must not contain parent traversal.`);
    }
    if (asset.share !== 'task' && asset.share !== 'root') invalid(`assets[${index}].share must be task or root.`);
    if (asset.kind === 'shared') {
      if (Object.hasOwn(asset, 'repo')) invalid(`Shared asset ${index} must not specify repo.`);
      return { kind: 'shared', path, share: asset.share };
    }
    if (asset.kind === 'repo') {
      const repo = stringField(asset.repo, `assets[${index}].repo`, true);
      validateId(repo);
      return { kind: 'repo', path, share: asset.share, repo };
    }
    invalid(`assets[${index}].kind must be shared or repo.`);
  });
}

function parse(content: string) {
  const parts = splitDocument(content);
  const document = parseDocument(parts.yaml, {
    version: '1.2', schema: 'core', strict: true, uniqueKeys: true,
    resolveKnownTags: false, keepSourceTokens: true,
  });
  if (document.errors.length || document.warnings.length) {
    invalid('Task frontmatter contains invalid or unsupported YAML.', [...document.errors, ...document.warnings].map((error) => error.message));
  }
  if (!isMap(document.contents)) invalid('Task frontmatter must be a YAML mapping.');
  const data = decode(document.contents) as Record<string, unknown>;
  if (data.schema !== 1) {
    throw new TaskError('UNSUPPORTED_SCHEMA', 'Task schema must be the integer 1.', 'Use a task document with schema: 1.');
  }
  const id = stringField(data.id, 'id', true);
  validateId(id);
  const title = stringField(data.title, 'title', true);
  const status = Object.hasOwn(data, 'status') ? data.status : 'todo';
  if (typeof status !== 'string' || !STATUSES.has(status)) invalid('status must be todo, in_progress, done, or canceled.');
  const parent = nullableString(Object.hasOwn(data, 'parent') ? data.parent : null, 'parent');
  if (parent !== null) validateId(parent);
  const dependencies = Object.hasOwn(data, 'blocked_by') ? data.blocked_by : [];
  if (!Array.isArray(dependencies)) invalid('blocked_by must be an array of task IDs.');
  const blocked_by = dependencies.map((value: unknown) => {
    const dependency = stringField(value, 'blocked_by entry', true);
    validateId(dependency);
    return dependency;
  });
  const order = stringField(data.order, 'order', true);
  if (!/^[A-Za-z][0-9A-Za-z]+$/.test(order)) invalid('order must be a valid fractional-indexing key.');
  try {
    // The library validates the integer prefix and canonical fractional suffix.
    generateKeyBetween(order, null);
  } catch {
    invalid('order must be a valid fractional-indexing key.');
  }
  const repo = nullableString(Object.hasOwn(data, 'repo') ? data.repo : null, 'repo');
  if (repo !== null) validateId(repo);
  const assets = parseAssets(Object.hasOwn(data, 'assets') ? data.assets : []);
  const archived = Object.hasOwn(data, 'archived') ? data.archived : false;
  if (typeof archived !== 'boolean') invalid('archived must be a boolean.');
  const diagnostics: Diagnostic[] = Object.keys(data)
    .filter((field) => !FIELDS.has(field))
    .map((field) => ({ code: 'UNKNOWN_FIELD', message: `Unknown frontmatter field: ${field}.`, severity: 'warning', taskId: id }));
  const task: Task = {
    schema: 1, id, title, status: status as Task['status'], parent,
    blocked_by, order, repo, assets, archived, body: parts.body,
  };
  return { task, diagnostics, document, parts };
}

export function parseTask(content: string): { task: Task; diagnostics: Diagnostic[] } {
  const { task, diagnostics } = parse(content);
  return { task, diagnostics };
}

export function createDocument(task: Task): string {
  const document = new Document();
  for (const field of FIELDS) document.set(field, task[field as keyof Task]);
  const body = stringField(task.body, 'body');
  const content = `---\n${document.toString({ lineWidth: 0 })}---\n${body}`;
  parseTask(content);
  return content;
}

export function updateDocument(content: string, changes: Partial<Task>): string {
  const { document, parts } = parse(content);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) invalid('Task changes must be an object.');
  const keys = Object.keys(changes);
  for (const key of keys) {
    if (key !== 'body' && !FIELDS.has(key)) invalid(`Cannot update unknown task field: ${key}.`);
    if (changes[key as keyof Task] === undefined) invalid(`Task field ${key} cannot be undefined.`);
  }
  const body = Object.hasOwn(changes, 'body') ? stringField(changes.body, 'body') : parts.body;
  if (keys.every((key) => key === 'body')) {
    // An EOF closing delimiter needs a newline only when a body is newly added.
    const separator = body && !parts.prefix.endsWith('\n') ? parts.newline : '';
    const updated = parts.prefix + separator + body;
    checkSize(updated);
    return updated;
  }
  for (const key of keys) {
    if (key === 'body') continue;
    const value = changes[key as keyof Task];
    const previous = document.get(key, true);
    const replacement = document.createNode(value);
    if (isScalar(previous) || isMap(previous) || isSeq(previous)) {
      replacement.comment = previous.comment;
      replacement.commentBefore = previous.commentBefore;
      replacement.spaceBefore = previous.spaceBefore;
      if (isScalar(previous) && isScalar(replacement) && typeof previous.value === typeof value) {
        replacement.type = previous.type;
      }
    }
    document.set(key, replacement);
  }
  let yaml = document.toString({ lineWidth: 0 });
  if (parts.newline === '\r\n') yaml = yaml.replace(/\r?\n/g, '\r\n');
  const closing = parts.closing + (body && !parts.closing.endsWith('\n') ? parts.newline : '');
  const updated = parts.opening + yaml + closing + body;
  parseTask(updated);
  return updated;
}

export function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
