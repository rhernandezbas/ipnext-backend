<!-- generated from engram topic_key: sdd/task-activity-log/proposal -->
## Proposal — task-activity-log

### Why
The task detail page's "Actividad" tab currently renders a `<ComingSoonPanel>` placeholder. Users have no way to audit what happened on a task: who created it, who reassigned it, when it moved through stages, who commented, what changed and when. This is the most-requested missing feature on the scheduling detail page. Backend has ZERO activity tracking today — no model, no port, no event emission. This change introduces the full backend surface so the frontend can list a chronological per-task activity log.

### What changes
1. New Prisma model `ScheduledTaskActivity` with JSON `fromValue` / `toValue` / `metadata` columns + a `type` discriminator.
2. New domain port `TaskActivityRepository` (read + write) + new domain entity `taskActivity`.
3. New adapters `PrismaTaskActivityRepository` + `InMemoryTaskActivityRepository`.
4. New application port `TaskActivityRecorder` (write-only, lightweight facade) injected into every scheduling write use case.
5. New use case `GetTaskActivity` (paginated, cursor-based) for the read side.
6. New use case `RecordTaskActivity` — internal-only, used by the recorder impl; kept as a use case so tests can exercise the recording semantics in isolation.
7. New HTTP route `GET /api/scheduling/tasks/:id/activity?limit=&cursor=`.
8. Wiring: each existing write UC receives a `TaskActivityRecorder` dependency. UC computes its event(s) and calls `recorder.record({...})` after the main write succeeds. Recorder errors are LOGGED, NOT THROWN — the user-facing write must not fail because audit insert failed.
9. New event types enum (string union):
   - `created`
   - `stage_changed`
   - `priority_changed`
   - `assigned` / `unassigned`
   - `commented` / `comment_deleted`
   - `status_changed` (isClosed toggle)
   - `attachment_added` / `attachment_removed` (piggy-back on comment events for now since attachments live inside comments)
   - `watcher_added` / `watcher_removed`
   - `category_changed`
   - `due_date_changed` (covers startDate AND endDate; payload metadata names which)
   - `description_changed`
   - `inventory_review_changed`
   - `sent_to_iclass`
   - `checklist_item_added` / `checklist_item_removed` / `checklist_item_toggled` / `checklist_item_updated` / `checklist_reordered` / `checklist_template_assigned` / `checklist_cleared`
   - `reporter_changed`
   - `project_changed`
   - `address_changed` (covers address + coordinates)
   - `estimated_hours_changed`
   - `travel_time_changed`
   - `notes_changed`

### Affected existing use cases (wiring impact)
The following 18 use cases must accept a `TaskActivityRecorder` (constructor-injected) and emit one or more events on success:
1. `CreateTask` → `created` (one event, captures initial assignee/watchers as metadata to avoid emitting N events at creation time).
2. `UpdateTask` → diff-based: emits 0..N events depending on which fields changed (priority/category/assignee/watchers/reporter/description/startDate/endDate/projectId/address/coordinates/estimatedHours/notes/travelTime*/isClosed). Watcher additions and removals emit one event per delta. `isClosed` → `status_changed`.
3. `MoveTaskToStage` → `stage_changed` (+ `sent_to_iclass` is emitted by the SendTaskToIClass branch).
4. `BulkMoveTasksToStage` → one `stage_changed` per task.
5. `DeleteTask` → no activity (row is gone; events are cascade-deleted by FK).
6. `AddTaskComment` → `commented` + per-attachment `attachment_added`.
7. `DeleteTaskComment` → `comment_deleted` (+ implicit `attachment_removed` events not required if comment scope is enough).
8. `SetTaskInventoryReview` → `inventory_review_changed`.
9. `AddChecklistItem` → `checklist_item_added`.
10. `UpdateChecklistItem` → `checklist_item_updated`.
11. `ToggleChecklistItem` → `checklist_item_toggled`.
12. `RemoveChecklistItem` → `checklist_item_removed`.
13. `ReorderChecklistItems` → `checklist_reordered`.
14. `AssignTemplateToTask` → `checklist_template_assigned`.
15. `ClearTaskChecklist` → `checklist_cleared`.
16. `SendTaskToIClass` → `sent_to_iclass`.
17. Routes that default `reporterId` to `req.user.id` — the route passes `actor` context into the use case (see Open Questions). Same applies to `customer*` fields if changed via UpdateTask.

### Out of scope (Phase 2 if needed)
- Standalone attachment endpoint on a task (today attachments only exist inside comments).
- Notifying watchers via push/email when events occur (this proposal only persists + exposes the log).
- Activity log on entities OTHER than `ScheduledTask` (tickets, projects, stages).
- Backfilling historical activity for tasks that existed before this change ships.
- Filtering by event type in the GET endpoint (can be added later without breaking change).

### Open questions resolved
- **How does the actor reach the use case?** The route reads `req.user` and passes `{ actorId, actorName }` as the second argument of every write UC `execute(...)` call. The recorder receives it from the UC. System-driven flows (e.g. IClass auto-send within MoveTaskToStage) carry actor through the chain.
- **Transactional integrity?** Best-effort sequential — main write first, then recorder.record. Recorder failures are logged at warn level; never thrown. Documented in Spec REQ-RESILIENCE-1.
- **Storage of `watcherIds` for the diff?** Repo `getTask` already returns `watcherIds: string[]`. UpdateTask receives next watchers and can compute add/remove sets before delegating to repo. Recorder gets two events per net change.
