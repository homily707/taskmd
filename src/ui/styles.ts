export const styles = `
.taskmd-app{--tm-border:color-mix(in srgb,currentColor 18%,transparent);--tm-muted:color-mix(in srgb,currentColor 65%,transparent);--tm-accent:#557ee8;--tm-bg-mix:color-mix(in srgb,var(--tm-accent) 12%,transparent);font:14px/1.5 system-ui,sans-serif;min-width:0;height:100%;overflow:auto;padding:16px;color:inherit;background:inherit;box-sizing:border-box}
.taskmd-app *{box-sizing:border-box}.taskmd-app h2,.taskmd-app h3,.taskmd-app h4{margin:0 0 10px}.taskmd-app h2{font-size:20px}.taskmd-app h3{font-size:18px;overflow-wrap:anywhere}.taskmd-app h4{font-size:14px}.taskmd-app p{margin:8px 0}.taskmd-app button,.taskmd-app input,.taskmd-app select,.taskmd-app textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--tm-border);border-radius:6px;padding:5px 9px;max-width:100%}.taskmd-app button{cursor:pointer}.taskmd-app button:hover{border-color:var(--tm-accent)}.taskmd-app button:disabled{opacity:.5;cursor:default}.taskmd-app button[aria-pressed=true],.taskmd-app button[aria-current=true],.taskmd-app button[aria-selected=true]{background:var(--tm-bg-mix);border-color:var(--tm-accent)}.taskmd-app input:not([type=checkbox]),.taskmd-app select{width:100%}.taskmd-app option{color:CanvasText;background:Canvas}.taskmd-app input[type=checkbox]{accent-color:var(--tm-accent)}.taskmd-app label{display:block;margin:10px 0}.taskmd-app label input:not([type=checkbox]),.taskmd-app label select{display:block;margin-top:4px}.taskmd-app textarea{width:100%;min-height:280px;resize:vertical;font:13px/1.6 ui-monospace,monospace;tab-size:2}.taskmd-app pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;border:1px solid var(--tm-border);border-radius:5px;max-height:420px;overflow:auto}.taskmd-app ul{padding-left:18px}.taskmd-app li{overflow-wrap:anywhere}
.taskmd-header{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.taskmd-header h2{margin:0 auto 0 0}.taskmd-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.taskmd-toolbar label{margin:0}
.taskmd-columns{display:grid;grid-template-columns:minmax(0,var(--tm-left,70fr)) 12px minmax(0,var(--tm-right,30fr));gap:0;align-items:start}
.taskmd-filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px}.taskmd-filters>input{flex:1 1 180px;min-width:0}.taskmd-filters>label{margin:0}.taskmd-filters .taskmd-repo-filter{flex:0 1 180px}.taskmd-filters .taskmd-check{display:flex;align-items:center}
.taskmd-main{min-width:0}.taskmd-details{min-width:0;padding-left:4px;overflow-wrap:anywhere}
.taskmd-check{display:flex;gap:6px;align-items:center;margin:0}
.taskmd-ready-entry{text-align:left}.taskmd-ready-entry.is-active{background:var(--tm-bg-mix);border-color:var(--tm-accent)}
.taskmd-tree{list-style:none!important;padding:0!important;margin:0}.taskmd-tree li{margin:3px 0}.taskmd-tree button{max-width:100%;text-align:left;display:block}.taskmd-tree strong{display:block;overflow-wrap:anywhere}.taskmd-tree small{color:var(--tm-muted);display:block}

.taskmd-outline{min-width:0}.taskmd-outline-hint{margin:0 0 8px}
.taskmd-outline .taskmd-tree>li{margin:0}
.taskmd-outline-row{display:flex;align-items:flex-start;gap:4px;border:1px solid transparent;border-radius:6px;padding:1px 2px}
.taskmd-app .taskmd-outline-label.is-done{border-color:#2e9e5b;background:color-mix(in srgb,#2e9e5b 9%,transparent);box-shadow:inset 3px 0 #2e9e5b}
.taskmd-app .taskmd-outline-label.is-done[aria-current=true]{box-shadow:inset 3px 0 #2e9e5b,0 0 0 1px var(--tm-accent)}
.taskmd-done-mark{color:#2e9e5b;font-weight:700}
.taskmd-outline-row:hover{border-color:var(--tm-border)}
.taskmd-app .taskmd-fold{flex:0 0 22px;width:22px;padding:4px 0;text-align:center;border-color:transparent}
.taskmd-outline-label{flex:1;min-width:0;padding:4px 6px;width:auto}
.taskmd-row-menu{position:relative;flex:none}.taskmd-row-menu>summary{list-style:none;cursor:pointer;border:1px solid var(--tm-border);border-radius:6px;padding:4px 7px}.taskmd-row-menu[open]>summary{border-color:var(--tm-accent)}.taskmd-row-menu>div{position:absolute;right:0;top:100%;z-index:30;display:flex;flex-direction:column;gap:4px;background:Canvas;border:1px solid var(--tm-border);border-radius:8px;padding:8px;box-shadow:0 6px 24px rgb(0 0 0/.18);min-width:132px;color:CanvasText}
.taskmd-drop-before{border-top:2px solid var(--tm-accent)}.taskmd-drop-after{border-bottom:2px solid var(--tm-accent)}.taskmd-drop-inside{border:2px solid var(--tm-accent);background:var(--tm-bg-mix)}
.taskmd-inline-create{border:1px dashed var(--tm-border);border-radius:8px;padding:8px;margin:4px 0 8px}
.taskmd-add-root{margin-top:8px}
.taskmd-view-toggle,.taskmd-pane-toggle{display:flex;gap:0}.taskmd-view-toggle button,.taskmd-pane-toggle button{border-radius:0}.taskmd-view-toggle button:first-child,.taskmd-pane-toggle button:first-child{border-radius:6px 0 0 6px}.taskmd-view-toggle button:last-child,.taskmd-pane-toggle button:last-child{border-radius:0 6px 6px 0}
.taskmd-badge{display:inline-block;border:1px solid var(--tm-border);border-radius:999px;padding:0 8px;font-size:12px;margin-right:6px}.taskmd-badge-ready{border-color:var(--tm-accent);color:var(--tm-accent)}
.taskmd-status-todo{color:var(--tm-muted)}.taskmd-status-in_progress{border-color:var(--tm-accent);color:var(--tm-accent)}.taskmd-status-done{color:#2e9e5b}.taskmd-status-canceled{color:var(--tm-muted);text-decoration:line-through}
.taskmd-blockers ul{margin:4px 0}
.taskmd-sessions{list-style:none;padding:0}.taskmd-sessions li{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:4px 0}.taskmd-sessions small{color:var(--tm-muted)}
.taskmd-box{border:1px solid var(--tm-border);border-radius:8px;padding:10px;margin:12px 0}
.taskmd-error{color:#d0453b;white-space:pre-wrap}
.taskmd-muted{color:var(--tm-muted)}
.taskmd-graph{height:460px;border:1px solid var(--tm-border);border-radius:8px}
.taskmd-session-sidebar{padding:10px}
.taskmd-detail-panel{padding:10px}
.taskmd-divider{align-self:stretch;min-height:200px;cursor:col-resize;touch-action:none;user-select:none;position:relative}
.taskmd-divider:before{content:"";position:absolute;inset:0 5px;background:var(--tm-border);border-radius:2px}
.taskmd-divider:hover:before,.taskmd-divider:focus-visible:before{background:var(--tm-accent)}
.taskmd-properties>summary,.taskmd-launcher>summary,.taskmd-assets>summary{cursor:pointer;font-weight:600}
.taskmd-app .taskmd-danger{color:#d0453b}
.taskmd-asset-row{margin-top:8px;padding-top:8px;border-top:1px solid var(--tm-border)}
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
.taskmd-app .taskmd-detail-title{font-size:16px;line-height:1.35;margin:0 0 4px}
.taskmd-detail-meta{display:flex;gap:8px;align-items:center;font-size:11px;line-height:1.4;margin-bottom:6px;min-width:0}
.taskmd-detail-meta>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.taskmd-detail-meta>span+span{flex-shrink:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.taskmd-detail-summary{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;font-size:12px;margin:0 0 6px}
.taskmd-detail-summary .taskmd-badge{margin:0}
.taskmd-app .taskmd-detail-summary button{padding:2px 7px;font-size:12px}
.taskmd-task-detail .taskmd-box{padding:8px;margin:8px 0}
/* Narrow view: one pane at a time, toggled from the header. */
.taskmd-app[data-pane=list] .taskmd-details{display:none}
.taskmd-app[data-pane=detail] .taskmd-main{display:none}
.taskmd-app[data-pane=list] .taskmd-columns,.taskmd-app[data-pane=detail] .taskmd-columns{grid-template-columns:minmax(0,1fr)}
.taskmd-app[data-pane=detail] .taskmd-details{border-left:0;padding-left:0}
@media(max-width:920px){.taskmd-details{border-left:0;padding-left:0}.taskmd-graph{height:380px}.taskmd-app{padding:10px}.taskmd-app:not([data-pane]) .taskmd-columns{grid-template-columns:1fr}.taskmd-app:not([data-pane]) .taskmd-details{border-left:0;border-top:1px solid var(--tm-border);padding:12px 0 0}}
`;
