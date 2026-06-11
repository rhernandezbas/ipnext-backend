# Proposal: Task General Status (open / closed / dismissed) — Backlog #41

## Intent

Tasks (client + node) need a management state independent of workflow stages: `open` (default at creation), `closed`, `dismissed`. Closed/dismissed leave the main views. Today only a soft-close Boolean `isClosed` exists, with no default exclusion and no "dismissed" concept.

## Scope

### In Scope
- BE: `generalStatus String @default("open")` on `ScheduledTask` + backfill from `isClosed`.
- BE: `status` query param (`open|closed|dismissed|all`) through the whole seam: zod → use case passthrough → both repos.
- BE: `POST /api/scheduling/:id/status` action (close/dismiss/reopen), `auth` + `scheduling.write`.
- BE: `isClosed` back-compat facade; exclude dismissed from IClass closure loops.
- FE: 4-option status filter in `TaskFilterBar` (default `open`) for both pages via `TasksPageBase`; close/dismiss/reopen actions in task detail; activity events.

### Out of Scope
- Mass actions (#46-style follow-up), Archive page rework, calendar changes beyond the default filter, dropping the `isClosed` column (follow-up change), IClass mirror ingestion changes.

## Capabilities

### New Capabilities
- `task-general-status`: lifecycle open/closed/dismissed, transitions, status action endpoint, permission, isClosed facade.

### Modified Capabilities
- `scheduling`: `status` list filter param (omit = all, back-compat).
- `scheduling-tasks-views`: default `status=open`, 4-option selector, closed/dismissed leave main view.
- `task-activity`: `status_changed` events with string values; cover dismissed/reopen.
- `iclass-closure-loop`: dismissed tasks excluded from closure/backfill/autocomplete loops.

## Approach

**Model**: `generalStatus` is the single source of truth. Reads derive `isClosed = generalStatus === 'closed'` in `toTask` (both repos); writes keep the DB column synced (one line in `updateTask`/create) only for ops tooling — no read path touches the column. Lowest risk: the 12 pinned `isClosed` tests stay green via facade; no dual-truth drift can surface to users.

**Write-path unification**: today the only `isClosed` writer is `PUT /:id` (UpdateTask). It stays, normalized at the use case: `isClosed:true → generalStatus:'closed'`, `false → 'open'`; explicit `generalStatus` wins if both present. New `SetTaskGeneralStatus` use case backs the action endpoint and emits activity events.

**Wire contract (frozen)**:
- `GET /api/scheduling?status=open|closed|dismissed|all`; omitted ≡ `all` (back-compat for existing callers). FE always sends explicit `status` (default `open`; "Todos" sends `all`).
- `POST /api/scheduling/:id/status { status }` — one endpoint over three verbs (one zod schema/use case) and over a PUT field (clean `scheduling.write` gate; `PUT /:id` has no permission today and per-field gating is messy). Mirrors the CloseTicket pattern.
- Task DTO adds `generalStatus`, keeps `isClosed` (derived).

**IClass policy**: `listTasksInIClassStage` (both repos) filters `generalStatus != 'dismissed'` — covers `ListInFlightTasks` + `BackfillClosedServiceOrders`; `IngestClosedServiceOrders` skips task side-effects when the matched task is dismissed (mirror row still ingested). Closed-by-IClass unchanged.

**Migration**: `prisma migrate dev --create-only` → additive column + appended idempotent backfill `UPDATE ... SET "generalStatus"='closed' WHERE "isClosed"=true`.

## Affected Areas

| Area | Impact |
|------|--------|
| `prisma/schema.prisma` + migration | New column + backfill |
| `src/domain/entities/scheduling.ts`, `src/domain/ports/SchedulingRepository.ts` | `generalStatus` field; `status` filter; port method |
| `src/application/dto/scheduling.dto.ts` | `status` enum in `ListTasksFilterSchema`; action schema |
| `src/application/use-cases/SetTaskGeneralStatus.ts` (new), `UpdateTask` normalize, `computeUpdateTaskActivities.ts` | Write-path + events |
| `src/infrastructure/adapters/prisma|in-memory/*SchedulingRepository.ts` | Facade, filter, dismissed exclusion |
| `src/infrastructure/http/routes/scheduling.routes.ts` | `status` param + `POST /:id/status` |
| FE: `types/scheduling.ts`, `api/scheduling.api.ts`, `useTasksFilterUrl.ts`, `TaskFilterBar`, `TasksPageBase`, `TaskHeader`, `TasksTableView` | Filter default + actions |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Facade drift (column vs enum) | Low | Reads never use the column; sync is one line per repo; pinned tests guard |
| Dismissed in-flight IClass task never reconciled | Med | By design (operator discarded); SO mirror still ingested; document |
| #40 seam conflicts (dto, repos, FE filter files) | Med | Branch from origin/main; additive keys only |
| Legacy boolean `status_changed` payloads render oddly | Low | Renderer handles both boolean and string values |

## Rollback Plan

Code revert is safe: column is additive with default `'open'`; legacy `isClosed` path untouched at DB level. FE revert independent (BE accepts omitted `status`). Column drop only via down migration if needed.

## Dependencies

- #40 (`TasksPageBase`, `kind` filter) merged on `origin/main` — confirmed.

## Success Criteria

- [ ] Backfill verified: `count(isClosed=true) == count(generalStatus='closed')`.
- [ ] Main list (both pages) defaults to open; closed/dismissed disappear on action; filter shows all 4 options.
- [ ] `PUT /:id { isClosed }` and `GET ?isClosed=` behave as before (12 tests green, untouched).
- [ ] Closure/backfill loops skip dismissed tasks; activity log records close/dismiss/reopen.
- [ ] `tsc` gate + full Jest suite green.
