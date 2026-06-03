<!-- generated from engram topic_key: sdd/task-activity-log/design -->
## Design — task-activity-log

### 1. Prisma model
```prisma
model ScheduledTaskActivity {
  id         String        @id @default(uuid())
  taskId     String
  task       ScheduledTask @relation(fields: [taskId], references: [id], onDelete: Cascade)
  type       String        // ActivityType union — kept as String for forward-compat
  actorId    String?
  actor      RbacUser?     @relation("TaskActivityActor", fields: [actorId], references: [id], onDelete: SetNull)
  actorName  String        // snapshot — survives user rename/delete
  fromValue  Json?
  toValue    Json?
  metadata   Json?
  createdAt  DateTime      @default(now())

  @@index([taskId, createdAt(sort: Desc), id(sort: Desc)])
  @@index([actorId])
}
```
- Migration: `20260530000000_add_scheduled_task_activity` (or next free slot).
- Back-relation added on `RbacUser` (`taskActivities ScheduledTaskActivity[] @relation("TaskActivityActor")`) and on `ScheduledTask` (`activities ScheduledTaskActivity[]`).

### 2. Domain layer

`src/domain/entities/taskActivity.ts`
```ts
export type ActivityType =
  | 'created'
  | 'stage_changed'
  | 'priority_changed'
  | 'category_changed'
  | 'assigned' | 'unassigned'
  | 'reporter_changed'
  | 'watcher_added' | 'watcher_removed'
  | 'commented' | 'comment_deleted'
  | 'attachment_added' | 'attachment_removed'
  | 'status_changed'
  | 'due_date_changed'
  | 'description_changed'
  | 'project_changed'
  | 'address_changed'
  | 'estimated_hours_changed'
  | 'travel_time_changed'
  | 'notes_changed'
  | 'inventory_review_changed'
  | 'sent_to_iclass'
  | 'checklist_item_added' | 'checklist_item_removed'
  | 'checklist_item_toggled' | 'checklist_item_updated'
  | 'checklist_reordered'
  | 'checklist_template_assigned'
  | 'checklist_cleared';

export interface TaskActivity {
  id: string;
  taskId: string;
  type: ActivityType;
  actorId: string | null;
  actorName: string;
  fromValue: unknown;
  toValue: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: string; // ISO
}
```

`src/domain/ports/TaskActivityRepository.ts`
```ts
export interface TaskActivityCursor { createdAt: string; id: string }
export interface ListTaskActivityFilter {
  taskId: string;
  limit: number;             // 1..200, clamped by use case
  cursor?: TaskActivityCursor;
}
export interface CreateTaskActivityInput {
  taskId: string;
  type: ActivityType;
  actorId: string | null;
  actorName: string;
  fromValue?: unknown;
  toValue?: unknown;
  metadata?: Record<string, unknown> | null;
}
export interface TaskActivityRepository {
  create(input: CreateTaskActivityInput): Promise<TaskActivity>;
  createMany(inputs: CreateTaskActivityInput[]): Promise<number>;
  listByTask(filter: ListTaskActivityFilter): Promise<TaskActivity[]>;
}
```

`src/domain/ports/TaskActivityRecorder.ts` — lightweight write-only port consumed by every write UC:
```ts
export interface ActorContext { actorId: string | null; actorName: string }
export interface TaskActivityRecorder {
  record(taskId: string, type: ActivityType, payload: {
    actor: ActorContext;
    fromValue?: unknown;
    toValue?: unknown;
    metadata?: Record<string, unknown> | null;
  }): Promise<void>;
  recordMany(taskId: string, events: Array<{
    type: ActivityType;
    actor: ActorContext;
    fromValue?: unknown;
    toValue?: unknown;
    metadata?: Record<string, unknown> | null;
  }>): Promise<void>;
}
```
Why a separate `Recorder` port distinct from the `Repository`:
- UCs only need write semantics + actor wrapping + warn-on-fail. Recorder owns the try/catch and the "best-effort" contract per REQ-RESILIENCE-1.
- The Repository keeps the clean CRUD shape and is used by the read use case (`GetTaskActivity`) and by the recorder implementation.

### 3. Application layer

`src/application/use-cases/GetTaskActivity.ts`
- Validates the task exists via `SchedulingRepository.getTask`. If null → throw `TaskNotFoundError`.
- Clamps `limit` to 1..200, default 50.
- Parses cursor (base64 of `createdAt|id`) — throws `InvalidCursorError` on malformed input.
- Calls `repo.listByTask(...)`.
- Returns `{ items, nextCursor }`.

`src/application/use-cases/RecordTaskActivity.ts` (internal)
- Thin wrapper over `TaskActivityRepository.create` — used by the recorder impl. Keeping it as a UC enables strict TDD unit tests around the persistence semantics independently of the recorder's resilience wrapper.

`src/infrastructure/services/DefaultTaskActivityRecorder.ts`
- Implements `TaskActivityRecorder`. Internally calls `RecordTaskActivity`. Wraps each call in try/catch — on error, logs warn and returns. Never throws.

### 4. UC wiring impact (the 18 affected files)

Each write UC gets a `recorder: TaskActivityRecorder` constructor dep and a second `actor: ActorContext` param on `execute(...)`. Routes already read `req.user`; route changes are mechanical.

Per-UC emission rules:

| UC | Event(s) emitted |
|---|---|
| `CreateTask` | `created` with `toValue` = snapshot of created task |
| `UpdateTask` | Diff current vs incoming partial. For each changed field emit its event. `assigneeId` change → `assigned` (new=non-null) or `unassigned` (new=null); both → `assigned` with metadata.previousAssigneeId. `watcherIds` → set diff → N × `watcher_added` + M × `watcher_removed`. `isClosed` → `status_changed`. `reviewedByInventory` → `inventory_review_changed`. `startDate`/`endDate` → `due_date_changed` with `metadata.field`. `address`+`coordinates` → coalesced to one `address_changed`. `travelTimeTo`+`travelTimeFrom` → one `travel_time_changed`. |
| `MoveTaskToStage` | `stage_changed` (fromStageId, toStageId, fromStageName, toStageName in metadata) on EVERY real stage move. When the IClass branch fires, `stage_changed` is recorded FIRST (before delegating), then `SendTaskToIClass` emits `sent_to_iclass` — so the feed shows both, in that order (spec REQ-MODEL-1). |
| `BulkMoveTasksToStage` | One `stage_changed` per affected task |
| `AddTaskComment` | `commented` + per-attachment `attachment_added` (metadata.commentId, metadata.attachmentId) |
| `DeleteTaskComment` | `comment_deleted` (metadata.commentId) |
| `SetTaskInventoryReview` | `inventory_review_changed` |
| `AddChecklistItem` | `checklist_item_added` (metadata.itemId, toValue.text) |
| `UpdateChecklistItem` | `checklist_item_updated` (fromValue.text, toValue.text) |
| `ToggleChecklistItem` | `checklist_item_toggled` (toValue.done) |
| `RemoveChecklistItem` | `checklist_item_removed` (metadata.itemId) |
| `ReorderChecklistItems` | `checklist_reordered` (metadata.orderedIds) |
| `AssignTemplateToTask` | `checklist_template_assigned` (metadata.templateId) |
| `ClearTaskChecklist` | `checklist_cleared` |
| `SendTaskToIClass` | `sent_to_iclass` (toValue.iclassOrderCode, metadata.stageId) |
| `DeleteTask` | NONE — row + activities cascade-deleted |

### 5. Adapters
- `PrismaTaskActivityRepository` — straight `prisma.scheduledTaskActivity.create / createMany / findMany`. `listByTask` builds a `where` with cursor: `[{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }]` joined by OR; orderBy `[{ createdAt: 'desc' }, { id: 'desc' }]`; `take = limit + 1` to compute `nextCursor`.
- `InMemoryTaskActivityRepository` — array-backed, same semantics. Required for use-case tests per project convention.

### 6. HTTP route
`scheduling.routes.ts` adds:
```ts
router.get('/:id/activity', auth, async (req, res) => {
  const limit = clamp(parseInt(req.query.limit as string ?? '50', 10), 1, 200);
  const cursor = req.query.cursor ? decodeCursor(req.query.cursor as string) : undefined;
  try {
    const result = await getTaskActivity.execute(req.params.id, { limit, cursor });
    res.json(result);
  } catch (err) {
    if (err instanceof TaskNotFoundError) return res.status(404).json({...});
    if (err instanceof InvalidCursorError) return res.status(400).json({...});
    throw err;
  }
});
```
Cursor encoding: `base64url(createdAt + '|' + id)`. Decode validates ISO date.

### 7. DI wiring in `app.ts`
- Instantiate `PrismaTaskActivityRepository`.
- Instantiate `DefaultTaskActivityRecorder(prismaTaskActivityRepository)`.
- Pass `recorder` to every write UC constructor.
- Instantiate `GetTaskActivity(schedulingRepository, taskActivityRepository)` and wire into `scheduling.routes`.
- Update routes to pass `actor = { actorId: req.user?.id ?? null, actorName: req.user?.name ?? 'System' }` to each write UC `execute`.

### 8. Error types
- `TaskNotFoundError` already exists in `@domain/errors/scheduling`.
- New `InvalidCursorError` in `@domain/errors/scheduling` (or new `taskActivity.ts` errors file).

### 9. Testing strategy (Strict TDD)
- Unit: `InMemoryTaskActivityRepository` cursor semantics, `GetTaskActivity` clamp/cursor/404 paths.
- Unit per write UC: assert recorder.record called with the right `type`, `fromValue`, `toValue`, `actor`. Use a fake recorder.
- Integration: supertest on `GET /api/scheduling/tasks/:id/activity` covering empty, single page, paginated, malformed cursor, 401, 404.
- Integration: after `POST /tasks`, `PUT /tasks/:id`, `PATCH /tasks/:id/stage`, `POST /tasks/:id/comments`, verify activity rows via the GET endpoint.
- Resilience test: inject a recorder that throws; assert the originating endpoint still returns 201/200.

### 10. Open design notes
- `actorName` is a snapshot — if an admin is renamed later, historical entries keep the old name. Trade-off accepted.
- `metadata` for stage/category/priority changes SHOULD include human labels (e.g. stage name) so the frontend doesn't need to re-resolve every id.
- Bulk move emits N inserts via `createMany` for efficiency.
