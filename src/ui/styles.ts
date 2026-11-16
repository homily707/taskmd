export const styles = `
/* taskmd uses the Host's theme tokens so light, dark and forced-colors stay native. */
.taskmd-app{
  --tm-text:var(--dsw-alias-label-primary,CanvasText);
  --tm-muted:var(--dsw-alias-label-secondary,color-mix(in srgb,CanvasText 62%,transparent));
  --tm-border:var(--dsw-alias-border-l1,color-mix(in srgb,CanvasText 15%,transparent));
  --tm-border-strong:var(--dsw-alias-border-l2,color-mix(in srgb,CanvasText 28%,transparent));
  --tm-accent:var(--dsw-alias-brand-primary,#557ee8);
  --tm-ok:var(--dsw-alias-state-success-primary,#2e9e5b);
  --tm-warn:var(--dsw-alias-state-warn-primary,#d98a00);
  --tm-err:var(--dsw-alias-state-error-primary,#d0453b);
  --tm-run:#2f7de1;
  --tm-surface:var(--dsw-alias-bg-layer-1,Canvas);
  --tm-surface-2:var(--dsw-alias-bg-layer-2,color-mix(in srgb,Canvas 96%,CanvasText));
  --tm-hover:color-mix(in srgb,var(--tm-text) 6%,transparent);
  --tm-accent-soft:color-mix(in srgb,var(--tm-accent) 12%,transparent);
  color:var(--tm-text);
  background:transparent;
  font:13px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  min-width:0;
  height:100%;
  box-sizing:border-box;
  container:taskmd / inline-size;
}
.taskmd-app *{box-sizing:border-box}
.taskmd-app :where(button,input,select,textarea){font:inherit;color:inherit;background:color-mix(in srgb,var(--tm-surface) 72%,transparent);border:1px solid var(--tm-border);border-radius:7px;padding:5px 9px;min-height:30px;max-width:100%}
.taskmd-app :where(button){cursor:pointer;transition:background-color 140ms ease-out,border-color 140ms ease-out,scale 140ms ease-out}
.taskmd-app :where(button:hover:not(:disabled)){background:var(--tm-hover);border-color:var(--tm-border-strong)}
.taskmd-app :where(button:active:not(:disabled)){scale:.98}
.taskmd-app :where(button:disabled){opacity:.45;cursor:default}
.taskmd-app :where(input:not([type=checkbox]),select){width:100%}
.taskmd-app :where(input,select,textarea):focus-visible,.taskmd-app :where(button,summary):focus-visible{outline:2px solid var(--tm-accent);outline-offset:2px}
.taskmd-app :where(input,select,textarea){outline-color:var(--tm-accent)}
.taskmd-app :where(input,select,textarea)::placeholder{color:var(--tm-muted)}
.taskmd-app :where(button:focus-visible){position:relative;z-index:1}
.taskmd-app :where(label){display:block;font-size:12px;color:var(--tm-muted);margin:8px 0 4px}
.taskmd-app :where(fieldset){border:1px solid var(--tm-border);border-radius:8px;padding:10px;min-width:0}
.taskmd-app :where(legend){font-size:12px;color:var(--tm-muted);padding-inline:4px}
.taskmd-app :where(details){border-top:1px solid var(--tm-border);padding:8px 0}
.taskmd-app :where(details:first-child){border-top:0}
.taskmd-app :where(summary){cursor:pointer;min-height:28px;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--tm-muted);list-style:none}
.taskmd-app :where(summary)::-webkit-details-marker{display:none}
.taskmd-app :where(summary):hover{color:var(--tm-text)}
.taskmd-app :where(summary)::before{content:"";width:0;height:0;border-inline-start:4px solid currentColor;border-block:3.5px solid transparent;flex:none;transition:rotate 150ms ease-out}
.taskmd-app :where(details[open])>:where(summary)::before{rotate:90deg}
.taskmd-app :where(h2,h3,h4){color:var(--tm-text);margin:0 0 8px;line-height:1.3}
.taskmd-app :where(h2){font-size:18px;font-weight:650;letter-spacing:-.01em}
.taskmd-app :where(h3){font-size:14px;font-weight:600}
.taskmd-app :where(p){margin:8px 0;overflow-wrap:anywhere}
.taskmd-app :where(ul){padding-inline-start:18px}
.taskmd-app :where(li){overflow-wrap:anywhere}
.taskmd-muted{color:var(--tm-muted)}
.taskmd-home{color:var(--tm-muted);font-size:10.5px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.taskmd-error{color:var(--tm-err);white-space:pre-wrap;font-size:12px}
.taskmd-danger{color:var(--tm-err)}
.taskmd-notice{color:var(--tm-ok)}
.taskmd-visually-hidden:where(:not(:focus-within,:active)){position:absolute!important;clip-path:inset(50%)!important;overflow:hidden!important;width:1px!important;height:1px!important;margin:-1px!important;padding:0!important;border:0!important;white-space:nowrap!important}
.taskmd-inline-button{border:0!important;background:none!important;color:var(--tm-accent)!important;padding:0 4px!important;min-height:22px!important;text-decoration:underline;text-underline-offset:2px;font-size:inherit!important}
.taskmd-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--tm-hover);color:var(--tm-muted);font-size:10.5px;font-variant-numeric:tabular-nums}
.taskmd-check{display:flex!important;align-items:center;gap:6px;margin:0!important;font-size:11px!important;color:var(--tm-muted)!important}
.taskmd-check input{accent-color:var(--tm-accent);min-height:18px;margin:0}

/* Agent status: one shared visual language for header summaries, task chips and session dots. */
.taskmd-agent-summary{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.taskmd-agent-summary-label{font-size:10px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--tm-muted);margin-inline-end:2px}
.taskmd-agent-pill{display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;border-radius:999px;padding:1px 7px;font-size:10.5px;line-height:1.5;white-space:nowrap;font-variant-numeric:tabular-nums}
.taskmd-agent-pill.is-attention{color:var(--tm-warn);background:color-mix(in srgb,var(--tm-warn) 12%,transparent)}
.taskmd-agent-pill.is-running{color:var(--tm-run);background:color-mix(in srgb,var(--tm-run) 12%,transparent)}
.taskmd-agent-pill.is-fresh{color:var(--tm-ok);background:color-mix(in srgb,var(--tm-ok) 12%,transparent)}
.taskmd-agent-pill.is-running [aria-hidden=true]{animation:taskmd-pulse 1.2s ease-in-out infinite}
.taskmd-agent-idle{font-size:10.5px;color:var(--tm-muted)}
/* Status text shares the dot's level colors: warn/attention, run/running, ok/fresh. */
.taskmd-status-text.is-attention,.taskmd-status-text.is-archived{color:var(--tm-warn)}
.taskmd-status-text.is-running{color:var(--tm-run)}
.taskmd-status-text.is-fresh{color:var(--tm-ok)}
.taskmd-status-text.is-idle,.taskmd-status-text.is-blank,.taskmd-status-text.is-missing{color:var(--tm-muted)}
.taskmd-agent-chip{display:inline-flex;align-items:center;flex:none;max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:999px;padding:1px 6px;font-size:10px;line-height:1.6;background:var(--tm-hover);color:var(--tm-muted)}
.taskmd-agent-chip.is-attention{color:var(--tm-warn);background:color-mix(in srgb,var(--tm-warn) 12%,transparent)}
.taskmd-agent-chip.is-running{color:var(--tm-run);background:color-mix(in srgb,var(--tm-run) 12%,transparent)}
.taskmd-agent-chip.is-fresh{color:var(--tm-ok);background:color-mix(in srgb,var(--tm-ok) 12%,transparent)}

/* Left navigation rail and its compact sidebar form. */
.taskmd-left-rail-wrap{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 4px}
.taskmd-rail-button{width:34px;min-width:34px;height:34px;display:grid;place-items:center;border-color:transparent!important;background:transparent!important;font-size:17px;color:var(--tm-muted)}
.taskmd-rail-button:hover{background:var(--tm-hover)!important;color:var(--tm-text)}
.taskmd-left-sidebar{padding:0;display:flex;flex-direction:column;overflow:hidden;height:100%;min-height:calc(100cqh - 152px);background:transparent}
.taskmd-left-header{display:flex;align-items:center;gap:5px;padding:8px 8px 3px;flex:none;min-width:0}
.taskmd-left-brand{display:flex;align-items:center;gap:6px;min-width:0;flex:1}
.taskmd-left-brand h2{margin:0;font-size:13px;font-weight:650;letter-spacing:.01em;white-space:nowrap}
.taskmd-left-tools{display:flex;align-items:center;gap:0;flex:none}
.taskmd-icon-button{width:24px;min-width:24px;height:24px;min-height:24px!important;padding:0!important;border-color:transparent!important;background:transparent!important;color:var(--tm-muted);font-size:14px;display:grid;place-items:center}
.taskmd-icon-button:hover{background:var(--tm-hover)!important;color:var(--tm-text)}
.taskmd-text-button{min-height:24px!important;padding:1px 6px!important;border-color:transparent!important;background:transparent!important;font-size:10.5px!important;color:var(--tm-muted)}
.taskmd-text-button:hover{background:var(--tm-hover)!important;color:var(--tm-text)}
/* Cross-task active Sessions: the compact inbox above the outline. */
.taskmd-left-active{flex:none;padding:0 8px 4px;border-bottom:1px solid var(--tm-border);margin-bottom:3px}
.taskmd-left-active-head{display:flex;align-items:center;gap:3px;min-height:22px;min-width:0}
.taskmd-left-active-head strong{font-size:11px;font-weight:600;flex:none}
.taskmd-left-active-head .taskmd-agent-pill{padding:0 5px;font-size:9.5px;line-height:1.5}
.taskmd-left-active-head .taskmd-nav-fold{height:20px;min-height:20px!important}
.taskmd-left-active-head .taskmd-muted{margin-inline-start:auto;font-size:9.5px;font-variant-numeric:tabular-nums}
.taskmd-left-active-list{display:flex;flex-direction:column;gap:1px;max-height:132px;overflow:auto;scrollbar-gutter:stable;padding:1px 0}
.taskmd-active-session{display:flex;align-items:center;gap:6px;width:100%;min-width:0;min-height:24px;padding:1px 4px!important;border:0!important;border-radius:6px;background:transparent!important;text-align:start}
.taskmd-active-session:hover{background:var(--tm-hover)!important}
.taskmd-active-session-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px}
.taskmd-active-session-meta{flex:none;font-size:9.5px;color:var(--tm-muted)}
.taskmd-left-search{padding:0 8px 4px;flex:none}
.taskmd-search-box{display:flex;align-items:center;gap:4px;border:1px solid var(--tm-border);border-radius:7px;background:color-mix(in srgb,var(--tm-text) 4%,transparent);padding:0 6px;transition:border-color 140ms ease-out,box-shadow 140ms ease-out}
.taskmd-search-box:focus-within{border-color:var(--tm-accent);box-shadow:0 0 0 3px var(--tm-accent-soft)}
.taskmd-search-icon{color:var(--tm-muted);font-size:13px;flex:none;line-height:1}
.taskmd-search-box input{border:0!important;background:transparent!important;min-height:26px!important;padding:2px 0!important;flex:1;min-width:0;outline:none!important;box-shadow:none!important;font-size:11.5px!important}
.taskmd-search-clear{width:20px;min-width:20px;height:20px;min-height:20px!important;padding:0!important;border:0!important;background:transparent!important;color:var(--tm-muted);font-size:14px;display:grid;place-items:center}
.taskmd-search-clear:hover{color:var(--tm-text)!important;background:var(--tm-hover)!important}
.taskmd-left-create{margin:0 8px 5px;padding:5px 6px;border:1px dashed var(--tm-border);border-radius:7px;display:flex;flex-direction:column;gap:3px;flex:none;background:color-mix(in srgb,var(--tm-text) 3%,transparent)}
.taskmd-left-create input,.taskmd-left-create select{min-height:26px!important;padding:2px 7px!important;font-size:11.5px!important}
.taskmd-left-create-actions{display:flex;gap:4px;margin-top:1px}
.taskmd-left-create-actions button{min-height:24px!important;padding:1px 8px!important;font-size:11px!important}
.taskmd-left-scroll{flex:1;min-height:0;overflow:auto;padding:0 4px 6px;scrollbar-gutter:stable;overscroll-behavior:contain}
.taskmd-left-footer{flex:none;border-top:1px solid var(--tm-border);padding:3px 8px 4px;background:transparent}
.taskmd-left-footer-row{display:flex;align-items:center;gap:6px;min-width:0;margin-bottom:1px}
.taskmd-left-footer-row .taskmd-archive-toggle{margin:0!important;flex:none;font-size:10px!important}
.taskmd-left-footer-row .taskmd-home{flex:1;min-width:0;margin:0;font-size:9.5px;line-height:1.3}
.taskmd-left-footer .taskmd-settings{border:0;padding:0;margin:0}
.taskmd-left-footer .taskmd-settings>summary{font-size:10px;min-height:22px;color:var(--tm-muted)}
.taskmd-left-footer .taskmd-settings form{margin-top:2px}
.taskmd-left-footer .taskmd-diagnostics>summary{font-size:10px;min-height:22px}
.taskmd-left-footer .taskmd-diagnostics ul{font-size:10px;padding-inline-start:16px;margin:4px 0}

/* Task tree: one compact line per Task; Sessions stay behind a badge. */
.taskmd-tree{list-style:none;margin:0;padding:0}
.taskmd-nav-tree>li{padding-inline-start:calc(var(--task-depth,0) * 10px)}
.taskmd-nav-row{position:relative;display:flex;align-items:center;gap:3px;min-height:32px;border-radius:6px;padding:1px 2px;transition:background-color 120ms ease-out}
.taskmd-nav-row:hover{background:var(--tm-hover)}
.taskmd-nav-hit{position:absolute!important;inset:0;z-index:0!important;border:0!important;background:transparent!important;padding:0!important;border-radius:6px;cursor:pointer}
.taskmd-nav-hit:focus-visible{outline:2px solid var(--tm-accent);outline-offset:-2px}
.taskmd-nav-row>:not(.taskmd-nav-hit){position:relative;z-index:1;pointer-events:none}
.taskmd-nav-fold,.taskmd-session-badge{pointer-events:auto!important}
.taskmd-nav-row.is-selected{background:var(--tm-accent-soft);box-shadow:inset 2px 0 0 var(--tm-accent)}
.taskmd-nav-row.is-busy{opacity:.65}
.taskmd-nav-fold{width:18px;min-width:18px;height:26px;min-height:26px!important;padding:0!important;border:0!important;background:transparent!important;color:var(--tm-muted);font-size:9px;display:grid;place-items:center;flex:none}
.taskmd-nav-fold:hover{color:var(--tm-text)!important;background:var(--tm-hover)!important}
.taskmd-nav-label{flex:1;min-width:0;display:flex;align-items:center;border:0!important;background:transparent!important;padding:2px 1px!important;text-align:start;min-height:28px!important;overflow:hidden}
.taskmd-nav-title{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:450;line-height:1.35}
.taskmd-nav-row.is-selected .taskmd-nav-title{color:var(--tm-accent);font-weight:600}
.taskmd-session-badge{flex:none;border:1px solid transparent!important;border-radius:999px;padding:0 5px!important;min-height:18px!important;height:18px;font-size:9.5px!important;line-height:1;font-variant-numeric:tabular-nums;color:var(--tm-muted);background:var(--tm-hover)!important}
.taskmd-session-badge:hover{border-color:var(--tm-border-strong)!important}
.taskmd-session-badge.is-attention{color:var(--tm-warn);background:color-mix(in srgb,var(--tm-warn) 12%,transparent)!important}
.taskmd-session-badge.is-running{color:var(--tm-run);background:color-mix(in srgb,var(--tm-run) 12%,transparent)!important}
.taskmd-session-badge.is-fresh{color:var(--tm-ok);background:color-mix(in srgb,var(--tm-ok) 12%,transparent)!important}
.taskmd-empty-inline{padding:16px 8px;text-align:center;font-size:12px;color:var(--tm-muted)}
.taskmd-status-dot{display:inline-block;flex:none;width:10px;height:10px;border-radius:50%;border:1.5px solid color-mix(in srgb,currentColor 48%,transparent);position:relative;background:transparent;color:var(--tm-muted)}
.taskmd-status-dot.is-in_progress{border-color:var(--tm-accent);background:conic-gradient(var(--tm-accent) 0 50%,transparent 50% 100%)}
.taskmd-status-dot.is-done{border-color:var(--tm-ok);background:var(--tm-ok);color:#fff}
.taskmd-status-dot.is-done:after{content:"✓";position:absolute;inset:0;text-align:center;line-height:8px;font-size:7px;font-weight:700}
.taskmd-status-dot.is-canceled{opacity:.5}
.taskmd-status-dot.is-canceled:after{content:"";position:absolute;left:1px;right:1px;top:50%;height:1.5px;background:currentColor;rotate:-45deg}
.taskmd-session-dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:var(--tm-muted)}
.taskmd-session-dot.is-attention{background:var(--tm-warn)}
.taskmd-session-dot.is-running{background:var(--tm-run);animation:taskmd-pulse 1.2s ease-in-out infinite}
.taskmd-session-dot.is-fresh{background:var(--tm-ok)}
.taskmd-session-dot.is-archived,.taskmd-session-dot.is-missing{opacity:.4}
.taskmd-session-dot.is-idle{background:color-mix(in srgb,var(--tm-muted) 75%,transparent)}

/* Floating Session list: portalled to body, so it redeclares the theme tokens it needs. */
.taskmd-session-popover{--tm-text:var(--dsw-alias-label-primary,CanvasText);--tm-muted:var(--dsw-alias-label-secondary,color-mix(in srgb,CanvasText 62%,transparent));--tm-border:var(--dsw-alias-border-l1,color-mix(in srgb,CanvasText 15%,transparent));--tm-border-strong:var(--dsw-alias-border-l2,color-mix(in srgb,CanvasText 28%,transparent));--tm-accent:var(--dsw-alias-brand-primary,#557ee8);--tm-ok:var(--dsw-alias-state-success-primary,#2e9e5b);--tm-warn:var(--dsw-alias-state-warn-primary,#d98a00);--tm-run:#2f7de1;--tm-surface:var(--dsw-alias-bg-layer-1,Canvas);--tm-hover:color-mix(in srgb,CanvasText 6%,transparent);position:fixed;z-index:90;inset:auto;margin:0;overflow:auto;background:var(--tm-surface);color:var(--tm-text);border:1px solid var(--tm-border-strong);border-radius:9px;box-shadow:0 10px 32px rgb(0 0 0/.22);padding:4px;font:12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-sizing:border-box}
.taskmd-session-popover *{box-sizing:border-box}
.taskmd-session-popover button{font:inherit;color:inherit;cursor:pointer}
.taskmd-session-popover-item{display:flex;align-items:center;gap:6px;width:100%;min-width:0;border:0;border-radius:6px;padding:4px 4px;margin:1px 0;background:transparent;text-align:start;min-height:26px}
.taskmd-session-popover-item:hover{background:var(--tm-hover)}
.taskmd-session-popover-item:disabled{opacity:.5;cursor:default}
.taskmd-session-popover-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.taskmd-session-popover-meta{flex:none;font-size:10px;color:var(--tm-muted)}
.taskmd-session-popover-empty{margin:6px;font-size:11px;color:var(--tm-muted)}

/* Main workspace. */
.taskmd-full{padding:18px 22px 32px;overflow:auto}
.taskmd-app:not(.taskmd-full):not(.taskmd-left-sidebar):not(.taskmd-left-rail-wrap){padding:16px;overflow:auto}
.taskmd-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px;min-width:0}
.taskmd-heading{display:flex;align-items:center;gap:7px;flex:none}
.taskmd-heading h2{margin:0;font-size:20px;line-height:1.25}
.taskmd-header>.taskmd-home{margin-inline-start:auto;max-width:46%;font-size:11px}
.taskmd-columns{display:grid;grid-template-columns:minmax(230px,300px) minmax(0,1fr);gap:26px;align-items:start;min-width:0}
.taskmd-list-pane{min-width:0;position:sticky;top:0;max-height:calc(100dvh - 120px);overflow:auto;padding-inline-end:18px;border-inline-end:1px solid var(--tm-border);scrollbar-gutter:stable;overscroll-behavior:contain}
.taskmd-detail-pane{min-width:0}
.taskmd-back{display:none}
.taskmd-empty{padding:56px 16px;text-align:center;color:var(--tm-muted)}
.taskmd-detail{max-width:900px;margin:0 auto;min-width:0}
.taskmd-detail-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.taskmd-detail-title{margin:0;font-size:22px;line-height:1.25;letter-spacing:-.015em;overflow-wrap:anywhere;flex:1 1 260px}
.taskmd-detail-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-inline-start:auto}
.taskmd-detail-actions label{margin:0;white-space:nowrap}
.taskmd-detail-actions select{width:auto;min-width:104px}
.taskmd-danger-option{color:var(--tm-err)}
.taskmd-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:8px 0}
.taskmd-toolbar label{margin:0}
.taskmd-toolbar [aria-pressed=true]{background:var(--tm-accent-soft);border-color:var(--tm-accent);color:var(--tm-accent)}
.taskmd-body{margin:16px 0 4px}
.taskmd-body>.taskmd-toolbar{margin:0 0 10px}
.taskmd-body textarea{width:100%;min-height:360px;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;tab-size:2;resize:vertical}
/* Right-sidebar detail surface: the Markdown editor fills the pane's remaining height and full width. */
.taskmd-detail-panel{display:flex;flex-direction:column;overflow:auto}
.taskmd-detail-panel .taskmd-detail{flex:1;display:flex;flex-direction:column;min-height:0;max-width:none;margin:0}
.taskmd-detail-panel .taskmd-body{flex:1;display:flex;flex-direction:column;min-height:220px;margin:10px 0 4px}
.taskmd-detail-panel .taskmd-body>label{flex:none}
.taskmd-detail-panel .taskmd-body textarea{flex:1;min-height:0;resize:none}
.taskmd-detail-panel .taskmd-body>.taskmd-md{flex:1;min-height:0;overflow:auto;margin:0}
.taskmd-prompt{border:0;padding:2px 0}
.taskmd-prompt textarea{width:100%;min-height:140px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
.taskmd-conflict{border:1px solid var(--tm-warn);background:color-mix(in srgb,var(--tm-warn) 7%,transparent);border-radius:8px;padding:10px 12px;margin:10px 0}
.taskmd-conflict pre{white-space:pre-wrap;max-height:260px;overflow:auto;font-size:12px;padding:8px;background:var(--tm-hover);border-radius:6px}

/* Outline filter and form controls in the main pane. */
.taskmd-outline .taskmd-filters{display:flex;align-items:center;gap:7px;margin-bottom:8px}
.taskmd-outline .taskmd-filters input{flex:1;min-width:0;padding:4px 8px;font-size:12px}
.taskmd-outline .taskmd-create{border:1px dashed var(--tm-border);border-radius:8px;padding:0 8px;margin:0 0 8px;background:color-mix(in srgb,var(--tm-surface) 40%,transparent)}
.taskmd-outline .taskmd-create>summary{min-height:30px;font-size:12px}
.taskmd-outline .taskmd-create form{display:flex;flex-direction:column;gap:2px;padding-bottom:8px}
.taskmd-outline-tree{margin-top:2px}
.taskmd-outline-tree>li{padding-inline-start:calc(var(--task-depth,0) * 14px)}
.taskmd-outline-row{display:flex;align-items:center;gap:4px;min-height:38px;border-radius:8px;padding:2px 3px}
.taskmd-outline-row:hover{background:var(--tm-hover)}
.taskmd-outline-row.is-selected{background:var(--tm-accent-soft)}
.taskmd-fold{width:24px;min-width:24px;height:28px;min-height:28px!important;padding:0!important;border:0!important;background:transparent!important;color:var(--tm-muted);font-size:10px;display:grid;place-items:center;flex:none}
.taskmd-fold:hover{background:var(--tm-hover)!important;color:var(--tm-text)!important}
.taskmd-outline-label{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;gap:1px;border:0!important;background:transparent!important;text-align:start;padding:4px 6px!important;min-height:32px!important}
.taskmd-outline-label:hover{background:transparent!important}
.taskmd-outline-label strong{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500}
.taskmd-outline-row.is-selected .taskmd-outline-label strong{color:var(--tm-accent);font-weight:600}
.taskmd-outline-label small{font-size:10.5px;color:var(--tm-muted)}

/* Cards and forms in the detail pane. */
.taskmd-settings,.taskmd-launcher,.taskmd-sessions,.taskmd-properties{border:1px solid var(--tm-border);border-radius:10px;padding:12px 14px;margin:12px 0;background:color-mix(in srgb,var(--tm-surface) 55%,transparent)}
.taskmd-settings>summary,.taskmd-launcher>summary,.taskmd-properties>summary{font-weight:600;font-size:12px;color:var(--tm-text);min-height:28px}
.taskmd-settings form,.taskmd-launcher form,.taskmd-properties form{display:flex;flex-direction:column;gap:2px;margin-top:4px}
.taskmd-settings form button,.taskmd-launcher form button,.taskmd-properties form button{align-self:flex-start;margin-top:8px}
.taskmd-launcher p:first-of-type{margin-top:4px}
.taskmd-launcher fieldset{margin-top:8px}
.taskmd-sessions ul{list-style:none;margin:6px 0 0;padding:0}
.taskmd-sessions li{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:7px 0;border-top:1px solid var(--tm-border);font-size:12px}
.taskmd-sessions li:first-child{border-top:0}
.taskmd-sessions li>button:first-child{border:0!important;background:transparent!important;padding:3px 5px!important;text-align:start;min-width:0;flex:1 1 180px}
.taskmd-sessions li>button:first-child:hover{background:var(--tm-hover)!important}
.taskmd-sessions details{flex:1 1 100%;border:0;padding:2px 0}
.taskmd-sessions h3{margin:0 0 4px}
.taskmd-path{font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--tm-muted);overflow-wrap:anywhere}

/* Markdown and attachments. */
.taskmd-md{font-size:14px;line-height:1.75;overflow-wrap:anywhere;min-height:120px;margin:12px 0;max-width:78ch}
.taskmd-md h1{font-size:24px;line-height:1.25;margin:0 0 10px}
.taskmd-md h2{font-size:19px;line-height:1.3;margin:22px 0 8px}
.taskmd-md h3{font-size:16px;line-height:1.35;margin:18px 0 6px}
.taskmd-md p{margin:0 0 10px}
.taskmd-md ul,.taskmd-md ol{margin:0 0 10px;padding-inline-start:22px}
.taskmd-md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--tm-hover);padding:1px 4px;border-radius:4px;font-size:.92em}
.taskmd-md pre{overflow:auto;max-height:420px;padding:10px 12px;background:var(--tm-hover);border:1px solid var(--tm-border);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}
.taskmd-md pre code{padding:0;background:none}
.taskmd-md a{color:var(--tm-accent);text-decoration-thickness:1px;text-underline-offset:2px}
.taskmd-md blockquote{margin:0 0 10px;padding-inline-start:12px;border-inline-start:3px solid var(--tm-border-strong);color:var(--tm-muted)}
.taskmd-attachment{display:block;max-width:100%;margin:10px 0}
.taskmd-attachment-text{display:block;white-space:pre-wrap;overflow:auto;max-height:400px;padding:10px 12px!important;border:1px solid var(--tm-border);border-radius:8px;font:12px/1.6 ui-monospace,monospace;background:var(--tm-hover)}
.taskmd-app img{max-width:100%;height:auto;border-radius:6px}

@keyframes taskmd-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){
  .taskmd-app :where(*){transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important}
}
@media (max-width:800px){.taskmd-full{padding:12px 14px 24px}}
@media (pointer:coarse){
  .taskmd-app :where(button,select,summary){min-height:40px}
  .taskmd-nav-fold,.taskmd-icon-button,.taskmd-search-clear{min-height:32px!important}
}
@container taskmd (max-width:680px){
  .taskmd-columns{display:block}
  .taskmd-list-pane{position:static;max-height:none;border-inline-end:0;padding-inline-end:0}
  .taskmd-detail-pane{display:none}
  .taskmd-show-detail .taskmd-list-pane{display:none}
  .taskmd-show-detail .taskmd-detail-pane{display:block}
  .taskmd-back{display:inline-block;margin-bottom:14px}
  .taskmd-header>.taskmd-home{max-width:100%;width:100%;margin-inline-start:0}
}
@container taskmd (max-width:360px){
  .taskmd-agent-chip{display:none}
  .taskmd-left-header{padding-inline:8px}
  .taskmd-left-search,.taskmd-left-sidebar .taskmd-agent-summary{padding-inline:8px}
}

/* Right sidebar: restrained surfaces, high-contrast actions, and a single scrolling task. */
.taskmd-app .taskmd-eyebrow{
  display:block;font-size:10px;line-height:1.5;letter-spacing:.09em;font-weight:700;
  color:var(--tm-muted);margin-bottom:4px;
}
.taskmd-app .taskmd-detail-head{
  display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
  padding:4px 0 17px;margin-bottom:0;border-bottom:1px solid var(--tm-border);
}
.taskmd-app .taskmd-detail-heading{flex:1 1 180px;min-width:0}
.taskmd-app .taskmd-detail-title{
  margin:0;font-size:clamp(17px,2.3cqi,22px);font-weight:690;line-height:1.36;
  letter-spacing:-.025em;overflow-wrap:anywhere;
}
.taskmd-app .taskmd-detail-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px}
.taskmd-app .taskmd-status-tag{
  display:inline-flex;align-items:center;gap:7px;min-height:23px;padding:2px 8px;
  background:var(--tm-hover);border:1px solid var(--tm-border);border-radius:999px;
  font-size:11px;font-weight:580;color:var(--tm-muted);
}
.taskmd-app .taskmd-status-tag.is-in_progress{color:var(--tm-accent);background:var(--tm-accent-soft);border-color:transparent}
.taskmd-app .taskmd-status-tag.is-done{color:var(--tm-ok);background:color-mix(in srgb,var(--tm-ok) 10%,transparent);border-color:transparent}
.taskmd-app .taskmd-status-tag .taskmd-status-dot{width:9px;height:9px}
.taskmd-app .taskmd-archived-label{color:var(--tm-muted);font-size:11px}
.taskmd-app .taskmd-detail-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex:0 1 auto;min-width:0;margin:0;position:relative}
.taskmd-app .taskmd-detail-actions select{
  width:auto;min-width:72px;max-width:112px;min-height:31px;
  padding:5px 24px 5px 8px;background:transparent;border-color:var(--tm-border);
  font-size:11px;
}
.taskmd-app .taskmd-primary-action,.taskmd-app .taskmd-save-button{
  background:var(--tm-accent)!important;color:#fff!important;border-color:transparent!important;
  font-weight:600;box-shadow:0 2px 7px color-mix(in srgb,var(--tm-accent) 17%,transparent);
}
.taskmd-app .taskmd-primary-action:hover:not(:disabled),.taskmd-app .taskmd-save-button:hover:not(:disabled){
  background:color-mix(in srgb,var(--tm-accent) 88%,black)!important;
}
.taskmd-app .taskmd-primary-action{white-space:nowrap;min-height:32px;padding:5px 10px;font-size:11.5px}
.taskmd-app .taskmd-delete-confirm{
  position:absolute;right:0;top:calc(100% + 7px);z-index:3;
  width:min(310px,90cqi);padding:12px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;
  background:var(--tm-surface);border:1px solid var(--tm-border-strong);
  border-radius:11px;box-shadow:0 12px 30px rgb(0 0 0/.15);
  font-size:12px;
}
.taskmd-app .taskmd-delete-confirm span{flex:1 1 100%;font-weight:600}
.taskmd-app .taskmd-delete-confirm .taskmd-danger{color:var(--tm-err);border-color:var(--tm-err)}
.taskmd-app .taskmd-editor-toolbar{
  display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:0 0 12px;padding:0;
}
.taskmd-app .taskmd-editor-tabs{display:flex;align-items:center;gap:2px;padding:3px;border-radius:9px;background:var(--tm-hover);margin-inline-end:auto}
.taskmd-app .taskmd-editor-tabs button{
  background:transparent;border:0;min-height:27px;padding:4px 10px;
  font-size:11.5px;border-radius:7px;color:var(--tm-muted);
}
.taskmd-app .taskmd-editor-tabs button[aria-pressed=true]{
  background:var(--tm-surface);color:var(--tm-text);box-shadow:0 1px 4px rgb(0 0 0/.10);font-weight:650;
}
.taskmd-app .taskmd-save-indicator{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;color:var(--tm-muted);white-space:nowrap}
.taskmd-app .taskmd-save-dot{width:6px;height:6px;border-radius:50%;background:var(--tm-ok)}
.taskmd-app .taskmd-save-indicator.is-dirty .taskmd-save-dot{background:var(--tm-warn)}
.taskmd-app .taskmd-save-button{padding:4px 10px;min-height:28px;font-size:11px}
.taskmd-app .taskmd-body{margin:0;padding:15px 0 4px}
.taskmd-app .taskmd-md{
  max-width:none;font-size:13px;line-height:1.8;
  color:var(--tm-text);margin:3px 0 10px;min-height:90px;
}
.taskmd-app .taskmd-md h1{font-size:19px}
.taskmd-app .taskmd-md h2{font-size:16px}
.taskmd-app .taskmd-md h3{font-size:14px}
.taskmd-app .taskmd-body textarea{
  background:var(--tm-surface-2);border:1px solid var(--tm-border);border-radius:10px;
  padding:12px 13px;font-size:12px;line-height:1.7;
}
.taskmd-app .taskmd-body textarea:focus-visible{border-color:var(--tm-accent);box-shadow:0 0 0 3px var(--tm-accent-soft)}
.taskmd-app .taskmd-sessions,.taskmd-app .taskmd-launcher,.taskmd-app .taskmd-properties{
  margin:9px 0 0;padding:13px 14px;border:1px solid var(--tm-border);border-radius:11px;
  background:color-mix(in srgb,var(--tm-surface) 66%,transparent);
}
.taskmd-app .taskmd-section-heading{display:flex;align-items:center;gap:7px;margin-bottom:9px}
.taskmd-app .taskmd-section-heading h3{margin:0;font-size:12px;font-weight:650}
.taskmd-app .taskmd-sessions .taskmd-session-list{display:flex;flex-direction:column;gap:3px;margin:0;padding:0}
.taskmd-app .taskmd-sessions .taskmd-session-row{
  display:flex;flex-wrap:nowrap;align-items:center;min-height:34px;gap:8px;
  border:1px solid transparent;border-radius:8px;background:var(--tm-hover);padding:3px 6px 3px 10px;
}
.taskmd-app .taskmd-session-row .taskmd-session-link{
  flex:1 1 auto;min-width:0;text-align:start;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;border:0;background:transparent!important;font-size:11.5px;padding:2px 0;
}
.taskmd-app .taskmd-session-row .taskmd-session-state{flex:none;font-size:10px}
.taskmd-app .taskmd-sessions .taskmd-session-more{position:relative;flex:none;width:26px;padding:0;border:0}
.taskmd-app .taskmd-session-more>summary{
  display:grid;place-items:center;width:26px;height:26px;min-height:26px;
  border-radius:7px;font-size:17px;letter-spacing:1px;color:var(--tm-muted);
}
.taskmd-app .taskmd-session-more>summary::before{display:none}
.taskmd-app .taskmd-session-more>summary:hover{background:var(--tm-hover)}
.taskmd-app .taskmd-session-more>button{
  position:absolute;right:0;top:calc(100% + 5px);z-index:4;min-width:96px;
  background:var(--tm-surface);border:1px solid var(--tm-border-strong);box-shadow:0 8px 24px rgb(0 0 0/.13);
}
.taskmd-app .taskmd-sessions-empty{margin:6px 0 8px;font-size:11.5px}
.taskmd-app .taskmd-sessions .taskmd-session-connect{margin-top:9px;padding:7px 0 0;border-top:1px solid var(--tm-border)}
.taskmd-app .taskmd-sessions .taskmd-session-connect>summary{font-size:11px;color:var(--tm-accent)}
.taskmd-app .taskmd-sessions .taskmd-session-connect form{padding:6px 0;display:flex;flex-direction:column;gap:5px}
.taskmd-app .taskmd-session-connect label{margin-bottom:0}
.taskmd-app .taskmd-launcher>summary{font-size:12px;min-height:28px;font-weight:650;color:var(--tm-text)}
.taskmd-app .taskmd-section-icon{
  width:22px;height:22px;display:inline-grid;place-items:center;background:var(--tm-accent-soft);
  color:var(--tm-accent);border-radius:7px;font-size:16px;font-weight:500;
}
.taskmd-app .taskmd-section-hint{margin-left:auto;color:var(--tm-muted);font-weight:400;font-size:10px}
.taskmd-app .taskmd-launcher[open]{border-color:color-mix(in srgb,var(--tm-accent) 35%,var(--tm-border))}
.taskmd-app .taskmd-launcher fieldset{padding:10px;border-radius:9px}
.taskmd-app .taskmd-launcher input[type=checkbox]{margin-right:6px;vertical-align:middle}
.taskmd-app .taskmd-properties>summary{font-size:11.5px;color:var(--tm-muted)}
.taskmd-app .taskmd-detail>details:last-child{margin:13px 0;padding:5px 2px}
.taskmd-app .taskmd-detail>details:last-child>summary{font-size:10.5px}
.taskmd-app.taskmd-detail-panel{padding:14px 16px 24px;min-width:0;scrollbar-gutter:stable}
.taskmd-detail-panel .taskmd-detail{max-width:none}
.taskmd-detail-panel .taskmd-detail-head{position:sticky;top:-14px;z-index:2;background:var(--tm-surface);padding-top:14px}
.taskmd-detail-panel .taskmd-body{margin:0;min-height:190px}
.taskmd-detail-panel .taskmd-body>.taskmd-md{max-width:none}
.taskmd-app.taskmd-session-sidebar{
  display:flex;flex-direction:column;gap:0;min-height:0;height:100%;overflow:hidden;
  padding:0!important;background:var(--tm-surface);
}
.taskmd-session-sidebar .taskmd-session-sidebar-head{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:19px 16px 14px;border-bottom:1px solid var(--tm-border);flex:none;
}
.taskmd-session-sidebar .taskmd-session-sidebar-head h2{
  display:flex;align-items:center;gap:7px;margin:0;font-size:16px;font-weight:700;letter-spacing:-.02em;
}
.taskmd-session-sidebar .taskmd-open-task{
  background:var(--tm-hover);border:0;padding:5px 9px;font-size:10.5px;white-space:nowrap;
}
.taskmd-session-sidebar .taskmd-panel-error{margin:10px 14px}
.taskmd-session-sidebar .taskmd-session-switcher{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px;border-bottom:1px solid var(--tm-border);flex:none}
.taskmd-session-sidebar .taskmd-session-switch{
  display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:5px 9px;
  font-size:11px;border:1px solid var(--tm-border);border-radius:999px;background:transparent;
}
.taskmd-session-sidebar .taskmd-session-switch span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.taskmd-session-sidebar .taskmd-session-switch.is-selected{background:var(--tm-accent-soft);color:var(--tm-accent);border-color:transparent}
.taskmd-session-sidebar .taskmd-session-task-content{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;padding:14px 16px 24px}
.taskmd-session-sidebar .taskmd-session-task-content .taskmd-detail{margin:0;max-width:none}
.taskmd-session-sidebar .taskmd-detail-head{position:relative}
.taskmd-session-sidebar .taskmd-detail-actions{flex-wrap:wrap}
.taskmd-session-sidebar .taskmd-body{min-height:0}
.taskmd-session-sidebar .taskmd-body textarea{min-height:240px}
.taskmd-session-sidebar .taskmd-panel-empty{
  flex:1;min-height:120px;padding:30px 20px;display:flex;flex-direction:column;
  align-items:center;justify-content:center;text-align:center;gap:6px;
}
.taskmd-session-sidebar .taskmd-empty-mark{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;background:var(--tm-accent-soft);color:var(--tm-accent);font-size:28px}
.taskmd-session-sidebar .taskmd-panel-empty strong{font-size:13px}
.taskmd-session-sidebar .taskmd-panel-empty p{max-width:240px;color:var(--tm-muted);font-size:11.5px;margin:0}
.taskmd-session-sidebar .taskmd-bind-panel{
  flex:none;margin:0;padding:9px 16px 12px;border-top:1px solid var(--tm-border);
  background:var(--tm-surface-2);max-height:48%;overflow-y:auto;
}
.taskmd-session-sidebar .taskmd-bind-panel>summary{font-weight:600;font-size:11.5px;color:var(--tm-text)}
.taskmd-session-sidebar .taskmd-bind-form{padding-top:8px;display:flex;flex-direction:column;gap:7px}
.taskmd-session-sidebar .taskmd-bind-form label{margin:0}
.taskmd-session-sidebar .taskmd-bind-form button{background:var(--tm-accent-soft);border-color:transparent;color:var(--tm-accent);font-weight:600}
@container taskmd (max-width:400px){
  .taskmd-app .taskmd-detail-head{flex-direction:column;gap:10px}
  .taskmd-app .taskmd-detail-actions{width:100%;justify-content:space-between}
  .taskmd-app .taskmd-detail-actions select{margin-left:auto}
  .taskmd-app .taskmd-session-state{display:none}
  .taskmd-session-sidebar .taskmd-session-sidebar-head{padding:15px 12px 12px}
  .taskmd-session-sidebar .taskmd-session-task-content{padding:12px}
  .taskmd-session-sidebar .taskmd-bind-panel{padding-inline:12px}
}
`;
