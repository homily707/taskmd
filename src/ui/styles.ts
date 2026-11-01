export const styles = `
.taskmd-app{--tm-border:color-mix(in srgb,currentColor 15%,transparent);--tm-line:color-mix(in srgb,currentColor 10%,transparent);--tm-muted:color-mix(in srgb,currentColor 62%,transparent);--tm-hover:color-mix(in srgb,currentColor 6%,transparent);--tm-accent:#557ee8;--tm-accent-mix:color-mix(in srgb,var(--tm-accent) 12%,transparent);--tm-ok:#2e9e5b;--tm-warn:#d98a00;--tm-run:#2f7de1;--tm-err:#d0453b;font:13.5px/1.5 system-ui,-apple-system,sans-serif;min-width:0;height:100%;overflow:auto;padding:14px;color:inherit;background:inherit;box-sizing:border-box}
.taskmd-app *{box-sizing:border-box}
.taskmd-app h2,.taskmd-app h3,.taskmd-app h4{margin:0 0 10px}
.taskmd-app h2{font-size:17px}.taskmd-app h3{font-size:17px;overflow-wrap:anywhere}
.taskmd-app h4{font-size:11.5px;font-weight:600;color:var(--tm-muted);text-transform:uppercase;letter-spacing:.05em}
.taskmd-app p{margin:8px 0}
.taskmd-app button,.taskmd-app input,.taskmd-app select,.taskmd-app textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--tm-border);border-radius:6px;padding:4px 9px;max-width:100%}
.taskmd-app button{cursor:pointer}.taskmd-app button:hover{border-color:color-mix(in srgb,currentColor 32%,transparent)}
.taskmd-app button:disabled{opacity:.45;cursor:default}
.taskmd-app button[aria-pressed=true],.taskmd-app button[aria-selected=true]{background:var(--tm-accent-mix);border-color:var(--tm-accent);color:var(--tm-accent)}
.taskmd-app input:not([type=checkbox]),.taskmd-app select{width:100%}
.taskmd-app option{color:CanvasText;background:Canvas}
.taskmd-app input[type=checkbox]{accent-color:var(--tm-accent)}
.taskmd-app label{display:block;margin:10px 0}.taskmd-app label input:not([type=checkbox]),.taskmd-app label select{display:block;margin-top:4px}
.taskmd-app textarea{width:100%;min-height:280px;resize:vertical;font:13px/1.6 ui-monospace,monospace;tab-size:2}
.taskmd-app pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;border:1px solid var(--tm-line);border-radius:6px;max-height:420px;overflow:auto;font-size:12.5px}
.taskmd-app ul{padding-left:18px}.taskmd-app li{overflow-wrap:anywhere}
.taskmd-muted{color:var(--tm-muted)}
.taskmd-error{color:var(--tm-err);white-space:pre-wrap}
.taskmd-app .taskmd-danger{color:var(--tm-err)}
/* Header: title, live agent pills, then view controls pushed to the right. */
.taskmd-header{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.taskmd-header h2{margin:0}
.taskmd-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.taskmd-toolbar label{margin:0}.taskmd-toolbar h4{margin:0;text-transform:none;letter-spacing:0;font-size:13px;font-weight:600;color:inherit}
.taskmd-view-toggle,.taskmd-pane-toggle{display:flex;margin-left:auto;background:var(--tm-hover);border-radius:7px;padding:2px}
.taskmd-view-toggle button,.taskmd-pane-toggle button{border:0;border-radius:5px;padding:3px 11px;color:var(--tm-muted)}
.taskmd-view-toggle button[aria-pressed=true],.taskmd-pane-toggle button[aria-selected=true]{background:inherit;color:inherit;box-shadow:0 1px 2px rgb(0 0 0/.14)}
.taskmd-columns{display:grid;grid-template-columns:minmax(0,var(--tm-left,58fr)) 12px minmax(0,var(--tm-right,42fr));gap:0;align-items:start}
.taskmd-main{min-width:0}.taskmd-details{min-width:0;padding-left:6px;overflow-wrap:anywhere}
.taskmd-divider{align-self:stretch;min-height:200px;cursor:col-resize;touch-action:none;user-select:none;position:relative}
.taskmd-divider:before{content:"";position:absolute;inset:0 5px;background:var(--tm-line);border-radius:2px}
.taskmd-divider:hover:before,.taskmd-divider:focus-visible:before{background:var(--tm-accent)}
/* Filter bar: search first, exclusive chips, repo and overflow at the end. */
.taskmd-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.taskmd-filters>input{flex:1 1 170px;min-width:0}
.taskmd-filters>label{margin:0}
.taskmd-filters .taskmd-repo-filter{flex:0 1 170px}
.taskmd-check{display:flex;gap:6px;align-items:center;margin:0}
.taskmd-filter-chips{display:flex;gap:4px;flex-wrap:wrap}
.taskmd-filter-chips button{border-radius:999px;padding:3px 11px;font-size:12.5px;color:var(--tm-muted)}
.taskmd-more-filters{position:relative}
.taskmd-more-filters>summary{list-style:none;cursor:pointer;border-radius:50%;width:28px;text-align:center;padding:4px 0}
.taskmd-more-filters>div{position:absolute;right:0;top:100%;z-index:30;background:Canvas;border:1px solid var(--tm-border);border-radius:8px;padding:10px;box-shadow:0 6px 24px rgb(0 0 0/.18);min-width:150px;color:CanvasText}
.taskmd-app .taskmd-more-filters .taskmd-check{color:CanvasText}
/* Outline: flat 30px rows, status icon left, quiet meta right. */
.taskmd-outline{min-width:0;container-type:inline-size}
.taskmd-tree{list-style:none!important;padding:0!important;margin:0}
.taskmd-tree li{margin:0}
.taskmd-outline-row{display:flex;align-items:center;gap:2px;height:30px;border-radius:6px;padding:0 4px;border:1px solid transparent;position:relative}
.taskmd-outline-row:hover{background:var(--tm-hover)}
.taskmd-outline-row.is-selected{background:var(--tm-accent-mix)}
.taskmd-outline-row.is-selected .taskmd-outline-label strong{color:var(--tm-accent)}
.taskmd-app .taskmd-fold{flex:0 0 20px;width:20px;padding:4px 0;text-align:center;border-color:transparent;color:var(--tm-muted);font-size:10px}
.taskmd-app .taskmd-fold:hover{border-color:transparent;background:var(--tm-hover)}
.taskmd-status-dot{flex:none;width:14px;height:14px;margin:0 3px;border-radius:50%;border:1.6px solid color-mix(in srgb,currentColor 45%,transparent);position:relative}
.taskmd-status-dot.is-in_progress{border-color:var(--tm-accent);background:conic-gradient(var(--tm-accent) 0 50%,transparent 50% 100%)}
.taskmd-status-dot.is-done{border-color:var(--tm-ok);background:var(--tm-ok)}
.taskmd-status-dot.is-done:after{content:"✓";color:#fff;font-size:9px;font-weight:700;position:absolute;inset:0;text-align:center;line-height:12px}
.taskmd-status-dot.is-canceled{opacity:.45}
.taskmd-status-dot.is-canceled:after{content:"";position:absolute;left:1px;right:1px;top:50%;height:1.6px;background:currentColor;transform:rotate(-45deg)}
.taskmd-outline-label{flex:1;min-width:0;padding:2px 6px;width:auto;border-color:transparent!important;text-align:left;display:flex;align-items:center;gap:8px}
.taskmd-outline-label:hover{border-color:transparent!important;background:transparent}
.taskmd-outline-label strong{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;overflow-wrap:normal}
.taskmd-outline-label.is-done strong{color:var(--tm-muted)}
.taskmd-app .taskmd-outline-label.is-done{box-shadow:none}
.taskmd-done-mark{color:var(--tm-ok);font-weight:700}
.taskmd-row-meta{display:flex;align-items:center;gap:8px;flex:none;color:var(--tm-muted);font-size:12px;padding-right:2px}
.taskmd-row-meta .taskmd-agent-chip{margin-left:0}
.taskmd-progress{display:inline-flex;align-items:center;gap:5px}
.taskmd-progress i{display:block;width:34px;height:4px;border-radius:2px;background:var(--tm-line);overflow:hidden}
.taskmd-progress i:before{content:"";display:block;height:100%;width:var(--p,0%);background:var(--tm-ok)}
.taskmd-tag{padding:0 6px;border-radius:4px;background:var(--tm-hover);font-size:11.5px;white-space:nowrap}
.taskmd-row-lock{white-space:nowrap}
.taskmd-ready-flag{color:var(--tm-accent);white-space:nowrap}
.taskmd-row-menu{position:relative;flex:none;opacity:0;transition:opacity .12s}
.taskmd-outline-row:hover .taskmd-row-menu,.taskmd-row-menu[open]{opacity:1}
.taskmd-row-menu>summary{list-style:none;cursor:pointer;border:1px solid transparent;border-radius:6px;padding:4px 7px;color:var(--tm-muted)}
.taskmd-row-menu>summary:hover{border-color:var(--tm-border)}
.taskmd-row-menu[open]>summary{border-color:var(--tm-accent)}
.taskmd-row-menu>div{position:absolute;right:0;top:100%;z-index:30;display:flex;flex-direction:column;gap:4px;background:Canvas;border:1px solid var(--tm-border);border-radius:8px;padding:8px;box-shadow:0 6px 24px rgb(0 0 0/.18);min-width:132px;color:CanvasText}
.taskmd-drop-before{border-top:2px solid var(--tm-accent)}.taskmd-drop-after{border-bottom:2px solid var(--tm-accent)}
.taskmd-drop-inside{border:2px solid var(--tm-accent);background:var(--tm-accent-mix)}
.taskmd-inline-create{border:1px dashed var(--tm-border);border-radius:8px;padding:8px;margin:4px 0 8px}
.taskmd-add-root{margin-top:8px}
@container (max-width:560px){.taskmd-row-meta .taskmd-tag{display:none}.taskmd-progress span{display:none}}
@container (max-width:420px){.taskmd-row-meta .taskmd-progress{display:none}}
/* Badges and status labels in the detail summary. */
.taskmd-badge{display:inline-block;border:1px solid var(--tm-border);border-radius:999px;padding:0 9px;font-size:12px;margin-right:4px}
.taskmd-badge-ready{border-color:var(--tm-accent);color:var(--tm-accent)}
.taskmd-status-todo{color:var(--tm-muted)}
.taskmd-status-in_progress{border-color:var(--tm-accent);color:var(--tm-accent)}
.taskmd-status-done{color:var(--tm-ok)}
.taskmd-status-canceled{color:var(--tm-muted);text-decoration:line-through}
/* Cards: the detail column stacks titled cards instead of equal boxes. */
.taskmd-box{border:1px solid var(--tm-line);border-radius:10px;padding:11px 12px;margin:10px 0;background:color-mix(in srgb,currentColor 2.5%,transparent)}
.taskmd-box>summary{cursor:pointer;font-weight:600;font-size:11.5px;color:var(--tm-muted);text-transform:uppercase;letter-spacing:.05em;list-style:none;display:flex;align-items:center;gap:6px}
.taskmd-box>summary::-webkit-details-marker{display:none}
.taskmd-box>summary:before{content:"▸";font-size:9px;transition:transform .12s}
.taskmd-box[open]>summary:before{transform:rotate(90deg)}
.taskmd-box>h4{margin:0 0 8px}
.taskmd-properties>summary,.taskmd-launcher>summary,.taskmd-assets>summary{cursor:pointer}
.taskmd-app .taskmd-task-detail .taskmd-box{padding:10px 12px}
.taskmd-blockers ul{margin:4px 0}
.taskmd-detail-title{font-size:16px;line-height:1.35;margin:0 0 4px;font-weight:600}
.taskmd-detail-crumb{font-size:12px;color:var(--tm-muted);margin-bottom:2px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.taskmd-detail-crumb button{border:0;padding:0;color:var(--tm-muted);font-size:12px}
.taskmd-detail-crumb button:hover{border:0;color:var(--tm-accent);text-decoration:underline}
.taskmd-detail-meta{display:flex;gap:8px;align-items:center;font-size:11px;line-height:1.4;margin-bottom:6px;min-width:0}
.taskmd-detail-meta>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-muted)}
.taskmd-detail-meta>span+span{flex-shrink:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-muted)}
.taskmd-detail-summary{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;font-size:12px;margin:0 0 6px}
.taskmd-detail-summary .taskmd-badge{margin:0}
.taskmd-app .taskmd-detail-summary button{padding:2px 8px;font-size:12px}
/* Session sidebar (right tab bound to the current session). */
.taskmd-session-sidebar{padding:10px}
.taskmd-session-sidebar .taskmd-tree li{display:flex;align-items:center;gap:4px;margin:1px 0}
.taskmd-session-sidebar .taskmd-tree li>button:first-of-type{flex:1;min-width:0;display:flex;align-items:center;gap:8px;border-color:transparent!important;padding:4px 6px}
.taskmd-session-sidebar .taskmd-tree li>button:first-of-type:hover{border-color:transparent!important;background:var(--tm-hover)}
.taskmd-session-sidebar .taskmd-tree strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-weight:500}
.taskmd-session-sidebar .taskmd-tree small{color:var(--tm-muted);flex:none}
.taskmd-session-sidebar form{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.taskmd-session-sidebar form label{flex:1 1 150px;margin:0}
.taskmd-detail-panel{padding:10px}
.taskmd-graph{height:460px;border:1px solid var(--tm-line);border-radius:8px}
.taskmd-sessions{list-style:none;padding:0;margin:0}
.taskmd-sessions li{border-top:1px solid var(--tm-line)}
.taskmd-sessions li:first-child{border-top:0}
.taskmd-session-row{padding:7px 0}
.taskmd-asset-row{margin-top:8px;padding-top:8px;border-top:1px solid var(--tm-line)}
.taskmd-asset-heading{display:flex;align-items:flex-start;gap:6px}
.taskmd-app .taskmd-asset-toggle{flex:1;min-width:0;text-align:left;overflow-wrap:anywhere}
.taskmd-asset-heading>button:last-child{flex-shrink:0}
.taskmd-launch-options{border:0;padding:0;margin:0;min-width:0}
.taskmd-app .taskmd-launcher textarea{min-height:180px}
.taskmd-app .taskmd-property-fields{border:0;padding:0;margin:8px 0;min-width:0}
.taskmd-app .taskmd-property-row{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:start;gap:8px;margin:6px 0}
.taskmd-property-row>span{padding-top:5px;color:var(--tm-muted)}
.taskmd-property-row>div{min-width:0}
.taskmd-app .taskmd-property-row input:not([type=checkbox]),.taskmd-app .taskmd-property-row select{margin-top:0;min-width:0;padding:3px 6px}
.taskmd-property-action{margin-left:72px}
/* Agent execution status. */
.taskmd-agent-bar{display:flex;gap:6px;flex-wrap:wrap}
.taskmd-agent-pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 10px;font-size:12px;border-color:transparent}
.taskmd-agent-pill:hover{border-color:var(--tm-border)}
.taskmd-agent-pill.is-attention{color:var(--tm-warn)}
.taskmd-agent-pill.is-running{color:var(--tm-run)}
.taskmd-agent-pill.is-fresh{color:var(--tm-ok)}
.taskmd-agent-pill .taskmd-agent-glyph{font-size:10px}
.taskmd-agent-pill.is-running .taskmd-agent-glyph{animation:taskmd-pulse 1.2s infinite}
@keyframes taskmd-pulse{50%{opacity:.25}}
.taskmd-agent-chip{display:inline-block;padding:0 7px;border-radius:999px;font-size:11.5px;white-space:nowrap;background:var(--tm-hover);color:var(--tm-muted)}
.taskmd-agent-chip.is-attention{color:var(--tm-warn);background:color-mix(in srgb,var(--tm-warn) 13%,transparent)}
.taskmd-agent-chip.is-running{color:var(--tm-run);background:color-mix(in srgb,var(--tm-run) 12%,transparent)}
.taskmd-agent-chip.is-fresh{color:var(--tm-ok);background:color-mix(in srgb,var(--tm-ok) 12%,transparent)}
.taskmd-execution-head{display:flex;align-items:center;gap:8px}
.taskmd-execution-head h4{margin:0;flex:1}
.taskmd-new-session{padding:1px 9px;font-size:12px;color:var(--tm-accent);border-color:color-mix(in srgb,var(--tm-accent) 40%,transparent)}
.taskmd-agent-hint{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0;padding:6px 10px;border-radius:6px;font-size:12px;color:var(--tm-warn);background:color-mix(in srgb,var(--tm-warn) 9%,transparent)}
.taskmd-agent-hint.is-fresh{color:var(--tm-ok);background:color-mix(in srgb,var(--tm-ok) 9%,transparent)}
.taskmd-agent-hint button{margin-left:auto;padding:1px 8px;font-size:12px;color:inherit;border-color:currentColor}
.taskmd-session-row .taskmd-session-open{border-color:transparent!important;padding:2px 6px}
.taskmd-session-row .taskmd-session-open:hover{border-color:transparent!important;background:var(--tm-hover)}
.taskmd-session-row .taskmd-session-open small{display:block;color:var(--tm-muted);font-weight:400}
.taskmd-agent-badge{flex:none;width:20px;text-align:center;font-size:12px}
.taskmd-agent-badge.is-attention{color:var(--tm-warn)}
.taskmd-agent-badge.is-running{color:var(--tm-run);animation:taskmd-pulse 1.2s infinite}
.taskmd-agent-badge.is-fresh{color:var(--tm-ok)}
.taskmd-agent-badge.is-idle,.taskmd-agent-badge.is-blank,.taskmd-agent-badge.is-archived{color:var(--tm-muted)}
.taskmd-agent-badge.is-missing{color:var(--tm-err)}
.taskmd-session-meta{flex:2 1 180px;font-size:12px;min-width:0}
.taskmd-bind-existing{margin-top:8px}
.taskmd-bind-existing summary{cursor:pointer;color:var(--tm-muted);font-size:12px}
.taskmd-bind-existing form{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
.taskmd-bind-existing label{flex:1 1 200px;margin:0}
/* Narrow view: one pane at a time, toggled from the header. */
.taskmd-app[data-pane=list] .taskmd-details{display:none}
.taskmd-app[data-pane=detail] .taskmd-main{display:none}
.taskmd-app[data-pane=list] .taskmd-columns,.taskmd-app[data-pane=detail] .taskmd-columns{grid-template-columns:minmax(0,1fr)}
.taskmd-app[data-pane=detail] .taskmd-details{padding-left:0}
@media(max-width:920px){.taskmd-details{padding-left:0}.taskmd-graph{height:380px}.taskmd-app{padding:10px}.taskmd-app:not([data-pane]) .taskmd-columns{grid-template-columns:1fr}.taskmd-app:not([data-pane]) .taskmd-details{padding-left:0;padding-top:12px}}

/* Compact left navigation region. Its single-slot occupant must fill the DSH column. */
.taskmd-left-sidebar{height:100%;display:flex;flex-direction:column;min-height:0;padding:4px 6px 8px;overflow:hidden}
.taskmd-left-top{display:flex;align-items:center;gap:6px;padding:7px 4px;flex:none;min-width:0}
.taskmd-left-top>strong{font-size:12px;flex:1}
.taskmd-left-top>button{padding:2px 6px;font-size:11px}
.taskmd-left-attention{font-size:11px;color:var(--tm-warn)}
.taskmd-left-filters{display:flex;flex-direction:column;gap:5px;flex:none;padding:0 4px 7px}
.taskmd-left-filters input,.taskmd-left-filters select{min-width:0;width:100%;padding:5px 7px;font-size:12px}
.taskmd-left-list{min-height:60px;overflow:auto;flex:1}
.taskmd-left-item{list-style:none}
.taskmd-left-row{display:flex;align-items:center;gap:3px;min-width:0;min-height:30px;border-radius:6px}
.taskmd-left-row:hover{background:var(--tm-hover)}
.taskmd-left-row.is-selected{background:var(--tm-accent-mix)}
.taskmd-left-sidebar .taskmd-left-fold{border:0;padding:0;width:17px;flex:none;font-size:11px;color:var(--tm-muted);height:25px}
.taskmd-left-sidebar .taskmd-left-label{min-width:0;flex:1;border:0;text-align:left;padding:3px 2px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:12px}
.taskmd-left-sidebar .taskmd-status-dot{width:10px;height:10px;flex:none;margin:0 3px 0 0}
.taskmd-left-sidebar .taskmd-status-dot.is-done:after{font-size:8px;line-height:8px}
.taskmd-left-sidebar .taskmd-agent-chip{max-width:76px;overflow:hidden;text-overflow:ellipsis;padding:1px 4px;font-size:10px;margin-right:3px;flex:none}
.taskmd-left-sessions{padding:8px 4px 4px;max-height:42%;overflow:auto;border-top:1px solid var(--tm-line);flex:none}
.taskmd-left-session-head{display:flex;align-items:center;gap:6px;margin:0 0 5px;font-size:12px}
.taskmd-left-session-head strong{flex:1}
.taskmd-left-sidebar .taskmd-left-session{border:0;width:100%;display:flex;align-items:center;gap:6px;padding:6px 4px;text-align:left;min-width:0}
.taskmd-left-session:hover{background:var(--tm-hover)}
.taskmd-left-session-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:12px}
.taskmd-left-session small{font-size:10px;color:var(--tm-muted);flex:none}
.taskmd-left-session-dot{width:7px;height:7px;border-radius:50%;background:var(--tm-muted);flex:none}
.taskmd-left-session-dot.is-attention{background:var(--tm-warn)}
.taskmd-left-session-dot.is-running{background:var(--tm-run);animation:taskmd-pulse 1.2s infinite}
.taskmd-left-session-dot.is-fresh{background:var(--tm-ok)}
.taskmd-left-rail{display:block;width:38px;min-height:38px;margin:5px auto;background:transparent;border:0;border-radius:6px;cursor:pointer;color:inherit;font-size:20px}
.taskmd-left-rail:hover{background:color-mix(in srgb,currentColor 7%,transparent)}

`;
