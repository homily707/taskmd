import { createRoot } from 'react-dom/client';
import { createAgyAdapters } from './adapter.js';
import { AgyOutlinePane } from './outline-pane.js';

const agyThemeStyles = `
.taskmd-agy-shell {
  width: 100%;
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.taskmd-agy-shell .taskmd-app {
  --tm-text: var(--foreground, CanvasText);
  --tm-muted: var(--muted-foreground, color-mix(in srgb, CanvasText 62%, transparent));
  --tm-faint: var(--muted-foreground, color-mix(in srgb, CanvasText 46%, transparent));
  --tm-border: var(--border, color-mix(in srgb, CanvasText 15%, transparent));
  --tm-border-strong: var(--border, color-mix(in srgb, CanvasText 28%, transparent));
  --tm-accent: var(--primary, #557ee8);
  --tm-surface: var(--background, Canvas);
  --tm-surface-2: var(--card, var(--muted, color-mix(in srgb, Canvas 96%, CanvasText)));
  padding: 12px;
  overflow: auto;
}
`;

function mount() {
  const rootElement = document.getElementById('root');
  if (!rootElement) return;
  rootElement.dataset.mounted = 'true';
  const adapters = createAgyAdapters();
  const root = createRoot(rootElement);
  root.render(
    <div className="taskmd-agy-shell">
      <style>{agyThemeStyles}</style>
      <AgyOutlinePane
        port={adapters.port}
        sessions={adapters.sessions}
        sessionId={adapters.sessionId}
      />
    </div>,
  );
  window.addEventListener('beforeunload', () => adapters.dispose(), { once: true });
}

mount();
