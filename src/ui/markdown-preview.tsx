import { useEffect, useState, type ReactNode } from 'react';
import type { Attachment } from '../types.js';
import type { TaskPort } from './port.js';
import { failure } from './shared.js';

function AttachmentView({ href, label, image, taskId, port }: { href: string; label: string; image: boolean; taskId: string; port: TaskPort }) {
  const [attachment, setAttachment] = useState<Attachment>();
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(image);
  useEffect(() => {
    if (!opened) return;
    let active = true;
    void port.readAttachment(taskId, href).then(value => { if (active) setAttachment(value); }, cause => { if (active) setError(failure(cause)); });
    return () => { active = false; };
  }, [port, taskId, href, opened]);
  const content = attachment?.dataUrl ? <img src={attachment.dataUrl} alt={label} loading="lazy" /> : attachment?.content !== undefined ? <code className="taskmd-attachment-text" tabIndex={0} role="region" aria-label={label}>{attachment.content}</code> : <span>{error || '正在读取附件…'}</span>;
  return image ? content : <span className="taskmd-attachment"><button onClick={() => setOpened(value => !value)} aria-expanded={opened}>{label}</button>{opened && content}</span>;
}

/** Markdown is rendered as React text nodes; raw HTML and executable URLs stay inert. */
export function MarkdownPreview({ text, taskId, port }: { text: string; taskId?: string; port?: TaskPort }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  const inline = (value: string): ReactNode[] => {
    const result: ReactNode[] = [];
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|!?\[[^\]]*\]\([^)]+\))/g;
    let cursor = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index! > cursor) result.push(value.slice(cursor, match.index));
      const token = match[0];
      if (token.startsWith('`')) result.push(<code key={`c${key++}`}>{token.slice(1, -1)}</code>);
      else if (token.startsWith('**')) result.push(<strong key={`b${key++}`}>{token.slice(2, -2)}</strong>);
      else {
        const link = /^(!?)\[([^\]]*)\]\(([^)]+)\)$/.exec(token);
        const href = link?.[3]?.trim() ?? '';
        const image = link?.[1] === '!';
        const label = link?.[2] ?? token;
        const relative = !!href && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href);
        if (/^https?:\/\//i.test(href)) result.push(image ? <img key={`i${key++}`} src={href} alt={label} loading="lazy" /> : <a key={`l${key++}`} href={href} target="_blank" rel="noreferrer">{label}</a>);
        else if (relative && taskId && port) result.push(<AttachmentView key={`${taskId}:${href}:${key++}`} href={href} label={label} image={image} taskId={taskId} port={port} />);
        else result.push(label);
      }
      cursor = match.index! + token.length;
    }
    if (cursor < value.length) result.push(value.slice(cursor));
    return result;
  };

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }

    const fence = /^```/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!)) body.push(lines[index++]!);
      index += 1;
      blocks.push(<pre key={`f${key++}`} tabIndex={0} role="region" aria-label="代码块"><code>{body.join('\n')}</code></pre>);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length, 4);
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4';
      blocks.push(<Tag key={`h${key++}`}>{inline(heading[2]!)}</Tag>);
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const items: string[] = [];
      while (index < lines.length) {
        const next = /^\s*[-*+]\s+(.*)$/.exec(lines[index]!);
        if (!next) break;
        items.push(next[1]!);
        index += 1;
      }
      blocks.push(<ul key={`u${key++}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ul>);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const next = /^\s*\d+[.)]\s+(.*)$/.exec(lines[index]!);
        if (!next) break;
        items.push(next[1]!);
        index += 1;
      }
      blocks.push(<ol key={`o${key++}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ol>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]!;
      if (!next.trim() || /^(#{1,6})\s+|^\s*[-*+]\s+|^\s*\d+[.)]\s+|^```/.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push(<p key={`p${key++}`}>{inline(paragraph.join(' '))}</p>);
  }

  return <div className="taskmd-md">{blocks.length ? blocks : <p className="taskmd-muted">无正文</p>}</div>;
}
