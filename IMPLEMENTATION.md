# taskmd 0.3.0 implementation contract

Fresh DSH-only Home task workspace. Branch feat/home-workspace-0-3. No graph, old fields/compatibility, independent web, database/index/transaction engine. Task metadata and body in Home/<tasksDirectory>/<title>--<short-id>.md; the frontmatter UUID is the task identity. Default tasksDirectory `tasks`, configurable relative within Home. Home chosen from DSH workspaces, fixed independent of current Session. All Session targets offered from DSH workspace list, default Home. Plain manually-created Markdown is not imported: UI/Agent create through the same Host operation. No claim to cryptographically distinguish a deliberately forged generated document.

## Shared interfaces

`src/types.ts` and `src/ui/port.ts` are owned by lead. Read these first; request changes rather than editing them.

Core exports `TaskFiles` from `src/core/files.ts`:
- constructor({ localDirectory: string }): local-only settings/bindings JSON under this directory (in tests isolated temp dir). Unconfigured Home is empty string; tasksDirectory default tasks, homeWorkspaceId null.
- init(): Promise<void>; close(): void
- state(): Promise<State>; configure(settings: HomeSettings): Promise<State>
- read(id): Promise<TaskRecord>; create(input): Promise<TaskRecord>
- update(id, changes, expectedVersion): Promise<TaskRecord>; remove(id, expectedVersion): Promise<void>
- attachment(id, href): Promise<Attachment> (relative to task Markdown, may use ../assets but must resolve within Home after symlink checks; bounded size)
- bindings(taskId?): Promise<TaskSessionBinding[]>; bind(taskId, sessionId): Promise<void>; unbind(taskId, sessionId): Promise<void>; touch(sessionId): Promise<boolean>
- subscribe(listener: () => void): () => void (external writes notify too)

Home config is local JSON; bindings partitioned by canonical Home/tasks directory, no old-data migration. Four manual states, no dependency rules or state cascade. Parent structural validation only, no cycles/missing parents. Archive marks one task (UI hides its subtree); restore reveals subtree without changing descendants. Delete leaf only; report children rather than delete recursively. Integer/finite numeric order sorted with id tie-break. Creation validates title/parent, assigns id/order/status and writes exclusive. Title changes rename the Markdown file while keeping the frontmatter UUID stable. update/remove require content hash; local mutation serialized. Preserve draft upon conflicts. No full-library revision. External manual edits to plugin-created files remain supported. New format should have marker `taskmd: 0.3`; ordinary/old Markdown ignored with appropriate diagnostics for malformed managed files.

## Ownership

- core agent: src/core/* new implementation + test/files.test.ts only. May delete old core files after inspecting; coordinate with lead if other owners still reference them. No package/shared types edits.
- UI agent: src/ui/* EXCEPT port.ts (lead), plus test/ui-v3.test.ts. Own new outline/detail/editor/settings/session-launcher/prompt/styles and cleanup old UI code. Export TaskmdApp({port,sessions,initialTaskId?,sessionId?}), TaskmdLeftSidebar({port,sessions,wide,expandSidebar,onOpenTask,onActivateSession?,showSessions}) and TaskmdDetailPanel({port,sessions,taskId,sessionId?}), TaskmdSidebar({port,sessions,sessionId,onOpenTask}). Coordinate props with host agent.
- integration agent: src/dsh/*, src/adapters/*, new agent tool file(s) and test/dsh-v3.test.ts. Preserve real DSH mount/API integration but remove graph dependencies. Host delegates to TaskFiles. Agent tool supports same operations as UI using actual installed tool API. Coordinate user-visible actions/creation, settings and sessions.
- lead: package/build/old tests cleanup, documentation/AGENTS.md, integration fixes after owner finishes, validation.

## UI

Task row click enters the most recent Session and opens the right task sidebar; a sessionless Task opens Markdown. Hovering the row reveals its Session list; active sessions remain quick links. Task status and Agent status independent. Task create asks title + optional parent, no repo. Native status select. Markdown drafts survive navigation/external conflicts. Save-before-launch if dirty, send saved snapshot. Session launcher default Home Workspace ID, dropdown all DSH repos (titles+paths), model/preset supported. Resume failed creation/binding/send without duplicates. Settings Home select and tasksDirectory field; no Store/root terminology. No old properties/graph/assets forms. Normal relative Markdown attachments supported.

Modern guidance already retrieved at /var/folders/lk/41mb98_n769bmkltr8nddwk80000gn/T/mwg-guide-96205-1794668359046.md (read relevant ranges). Prefer native controls/details; container queries for panel widths; simple nav/list buttons + aria-expanded, not fake tree roles. Popover optional: if used detect HTMLElement.prototype.popover; fallback required. No uncontrolled portal/DOM injection. Keep labels/focus and keyboard entry for any session picker.

## Validation

Core isolated HOME/temp files only; never mutate real task data while testing. Source changed => build needed. Lead integrates typecheck/build/test and actual installed DSH URL. Agent registration, session workspace choices, retry state, external-edit draft conflict, created-file recognition and file path boundaries are key tests. No commit/push by agents.
