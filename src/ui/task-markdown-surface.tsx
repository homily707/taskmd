import { AtomicCodeMirrorEditor } from '@atomic-editor/editor';
import atomicStyles from '@atomic-editor/editor/styles.css';

/**
 * The build loads CSS as text (`loader: { '.css': 'text' }`), so the package
 * stylesheet arrives as a string and is rendered as a `<style>` element — the
 * same treatment `@xyflow/react` styles get in task-graph.tsx. A side-effect
 * import would not compile.
 */
const surfaceStyles = `
.taskmd-markdown-surface{position:relative;height:min(60vh,520px);min-height:280px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:6px;overflow:auto;--atomic-editor-fg:currentColor;--atomic-editor-fg-muted:color-mix(in srgb,currentColor 65%,transparent);--atomic-editor-code-bg:color-mix(in srgb,currentColor 6%,transparent);--atomic-editor-bg:transparent;--atomic-editor-bg-surface:transparent;--atomic-editor-bg-panel:color-mix(in srgb,currentColor 6%,transparent);--atomic-editor-border:color-mix(in srgb,currentColor 18%,transparent);--atomic-editor-link:#557ee8;--atomic-editor-link-hover:#557ee8;--atomic-editor-accent:#557ee8;--atomic-editor-body-size:0.875rem;--atomic-editor-measure:100%}
.taskmd-markdown-surface .cm-editor{height:100%;background:transparent;color:inherit}
.taskmd-markdown-surface .cm-scroller{font-family:ui-monospace,monospace}
`;

export interface TaskMarkdownSurfaceProps {
  /** Stable document identity: changing it remounts the view with the new body. */
  documentId: string;
  body: string;
  onChange(body: string): void;
}

/** Atomic Editor (CodeMirror 6) surface for the Markdown body only. */
export default function TaskMarkdownSurface({ documentId, body, onChange }: TaskMarkdownSurfaceProps) {
  return <div className="taskmd-markdown-surface">
    <style>{atomicStyles}{surfaceStyles}</style>
    <AtomicCodeMirrorEditor documentId={documentId} markdownSource={body} onMarkdownChange={onChange}
      onLinkClick={(url: string) => {
        // Only absolute web links leave the page; a Task body is not a
        // browsable document tree, so relative targets stay inert.
        try {
          const parsed = new URL(url, window.location.href);
          if (parsed.protocol === 'https:' || parsed.protocol === 'http:') window.open(parsed.href, '_blank', 'noopener,noreferrer');
        } catch { /* Invalid Markdown link. */ }
      }} />
  </div>;
}
