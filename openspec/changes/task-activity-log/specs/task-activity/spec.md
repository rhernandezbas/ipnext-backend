<!-- generated from engram topic_key: sdd/task-activity-log/spec -->
## Spec — task-activity-log

### Capability
The system records and exposes a per-task chronological activity log covering creation, field changes, assignment changes, comments, stage transitions, status toggles, and integration events.

### Entity: ScheduledTaskActivity
- `id: string (uuid)`
- `taskId: string` — FK to ScheduledTask, ON DELETE CASCADE
- `type: ActivityType` — string union (see proposal §What changes #9)
- `actorId: string | null` — Admin id (nullable for system events)
- `actorName: string` — snapshot of admin name OR `'System'`
- `fromValue: Json | null` — previous value of the field (shape depends on type)
- `toValue: Json | null` — new value of the field
- `metadata: Json | null` — extra context (e.g. `{ field: 'startDate' }` for `due_date_changed`, `{ commentId, attachmentId }` for comment family)
- `createdAt: DateTime` — auto-set on insert
- Index: `(taskId, createdAt DESC, id DESC)` for cursor pagination

### REQ-MODEL-1 — Persistence
- WHEN any tracked write succeeds, THE SYSTEM SHALL insert a `ScheduledTaskActivity` row whose `taskId` matches the affected task.
- WHEN the activity insert fails, THE SYSTEM SHALL log a warning AND NOT roll back the originating write.
- WHEN a task is deleted, THE SYSTEM SHALL cascade-delete its activity rows.

#### Scenarios
- WHEN user U creates task T, THE SYSTEM SHALL persist exactly one `created` activity with `actorId=U.id`, `actorName=U.name`, `fromValue=null`, `toValue={title, stageId, priority, category, assigneeId, watcherIds}`.
- WHEN user U updates task T changing `priority` from 'low' to 'high', THE SYSTEM SHALL persist one `priority_changed` activity with `fromValue='low'`, `toValue='high'`.
- WHEN user U updates task T changing both `priority` and `category` in the same request, THE SYSTEM SHALL persist TWO separate activities (one per field).
- WHEN user U updates task T changing `watcherIds` from `[a, b]` to `[a, c]`, THE SYSTEM SHALL persist one `watcher_removed` (`toValue=b`) and one `watcher_added` (`toValue=c`).
- WHEN user U updates task T setting `isClosed=true`, THE SYSTEM SHALL persist one `status_changed` activity with `fromValue=false`, `toValue=true`.
- WHEN the system auto-sends task T to IClass via MoveTaskToStage, THE SYSTEM SHALL persist one `stage_changed` AND one `sent_to_iclass` activity, in that order.
- WHEN user U adds a comment with 2 attachments, THE SYSTEM SHALL persist one `commented` activity AND two `attachment_added` activities with `metadata.commentId` set.
- WHEN the activity-insert side-effect throws, THE SYSTEM SHALL still return 201/200 for the originating request.

### REQ-READ-1 — GET /api/scheduling/tasks/:id/activity
- WHEN a GET request hits `/api/scheduling/tasks/:id/activity`, THE SYSTEM SHALL return up to `limit` (default 50, max 200) activity rows for that task ordered by `createdAt DESC, id DESC`.
- WHEN a `cursor` query param is present, THE SYSTEM SHALL return rows STRICTLY OLDER than the cursor (cursor encodes `createdAt|id`).
- WHEN the task does not exist, THE SYSTEM SHALL return 404 `{ code: 'TASK_NOT_FOUND' }`.
- WHEN the request is unauthenticated, THE SYSTEM SHALL return 401.
- THE response SHALL be `{ items: ActivityDto[], nextCursor: string | null }` where `nextCursor` is null when fewer than `limit` rows were returned.

#### Scenarios
- WHEN task T has 0 activities, THE response SHALL be `{ items: [], nextCursor: null }` with status 200.
- WHEN task T has 75 activities and the request omits `cursor` with `limit=50`, THE response SHALL contain the 50 newest and `nextCursor` SHALL be set.
- WHEN the same request is repeated with the returned `nextCursor`, THE response SHALL contain the remaining 25 and `nextCursor=null`.
- WHEN `limit=500` is requested, THE SYSTEM SHALL clamp to 200.
- WHEN `cursor` is malformed, THE SYSTEM SHALL return 400 `{ code: 'INVALID_CURSOR' }`.

### REQ-ACTOR-1 — Actor capture
- WHEN a write request carries an authenticated user, THE SYSTEM SHALL record `actorId = req.user.id` and `actorName = req.user.name`.
- WHEN a write happens with no authenticated user (e.g. system-triggered IClass auto-send delegated from MoveTaskToStage), THE SYSTEM SHALL record `actorId = null` and `actorName = 'System'`.

### REQ-RESILIENCE-1 — Best-effort recording
- WHEN the activity recorder throws, THE SYSTEM SHALL NOT fail the originating write.
- THE recorder SHALL log warnings with `taskId`, `type`, and the error message.

### REQ-DTO-1 — ActivityDto shape
```
ActivityDto {
  id: string
  taskId: string
  type: string
  actorId: string | null
  actorName: string
  fromValue: unknown
  toValue: unknown
  metadata: Record<string, unknown> | null
  createdAt: string  // ISO 8601
}
```
- THE SYSTEM SHALL NOT leak Prisma row shapes — adapters MUST map to ActivityDto / domain entity.

### Out of scope (per Proposal)
- Activity for entities other than ScheduledTask.
- Notifications/email.
- Backfilling existing tasks.
- Event-type filter query param.
