import type { ReactNode } from 'react';

/** A deliberately small, safe Markdown reader for the compact sidebar preview. */
export function MarkdownPreview({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  const inline = (value: string): ReactNode[] => {
    const result: ReactNode[] = [];
    const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
    let cursor = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index! > cursor) result.push(value.slice(cursor, match.index));
      const token = match[0];
      if (token.startsWith('`')) result.push(<code key={`c${key++}`}>{token.slice(1, -1)}</code>);
      else if (token.startsWith('**')) result.push(<strong key={`b${key++}`}>{token.slice(2, -2)}</strong>);
      else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
        result.push(link && /^https?:\/\//i.test(link[2]!)
          ? <a key={`l${key++}`} href={link[2]!} target="_blank" rel="noreferrer">{link[1]}</a>
          : link?.[1] ?? token);
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
      blocks.push(<pre key={`f${key++}`}><code>{body.join('\n')}</code></pre>);
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
