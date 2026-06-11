# Archive Report: task-general-status (#41)

**Change**: `task-general-status` (#41)  
**Date Archived**: 2026-06-11  
**Status**: SHIPPED TO PRODUCTION

---

## Deployment Summary

### Backend (Node/TypeScript)
- **PR**: #105 (merged to main)
- **Migration**: `20260624000000` applied
- **Tests**: Jest 3260/0 (all passing)
- **Type Check**: tsc clean
- **Deployed**: 2026-06-11

### Frontend (React)
- **PR**: #80 (merged to main)
- **Tests**: vitest 2369/0 (all passing)
- **Type Check**: typecheck clean
- **Deployed**: 2026-06-11

---

## Change Scope

### What Was Implemented

**Domain Abstraction**: Introduced `generalStatus` to replace the low-level deprecated `status` field (pending/in_progress/completed/cancelled). Three new states:
- `'open'` — Task is live and needs work (Abierta)
- `'closed'` — Task completed or transitioned by the system (Cerrada)
- `'dismissed'` — Operator intentionally discarded (Descartada)

**API Endpoint**: `POST /api/scheduling/:id/status { status: 'open'|'closed'|'dismissed' }`

**Frontend Filter & Actions**:
- Status filter in TaskFilterBar (4 options: Abierta, Cerrada, Descartada, Todos)
- Default to `status=open` on initial page load
- Status badges in list and detail views
- Context-aware actions in TaskHeader (Close, Dismiss, Reopen)

**IClass Integration**:
- Dismissed tasks excluded from automation loops
- IClass-closed tasks auto-set `generalStatus='closed'`
- SO mirroring proceeds; dismissed task side-effects skipped

**Activity Log**: `status_changed` events now carry string values (not boolean); legacy events with boolean values gracefully handled.

---

## Specs Synced to Main

| Capability | File | Action | Delta |
|---|---|---|---|
| `scheduling` | `openspec/specs/scheduling/spec.md` | UPDATED | Added REQ-GS-FILTER-1 for status query filter; updated REQ-SHAPE-2 to include `generalStatus` and `isClosed` fields |
| `scheduling-tasks-views` | `openspec/specs/scheduling-tasks-views/spec.md` | UPDATED | Added REQ-GS-VIEW-FILTER-1 (4-option filter), REQ-GS-VIEW-ACTIONS-1 (status actions), REQ-GS-VIEW-BADGE-1 (status badges); updated REQ-FILTER-7 |
| `task-activity` | `openspec/specs/task-activity/spec.md` | UPDATED | Modified REQ-MODEL-1 to record string-valued `status_changed` events; added scenarios for new generalStatus field and legacy boolean compatibility |
| `iclass-closure-loop` | `openspec/specs/iclass-closure-loop/spec.md` | UPDATED | Added REQ-GS-ICLASS-DISMISSED-1, REQ-GS-ICLASS-INGEST-1, REQ-GS-ICLASS-CLOSEDBY-FLOW-1, REQ-GS-ICLASS-DISMISSED-SEMANTIC-1 for dismissed task handling |
| `task-general-status` | `openspec/specs/task-general-status/spec.md` | CREATED | New capability spec summarizing the feature (state machine, API, FE, IClass integration) |

---

## Key Decisions & Fixes

### 1. Dismissed Task Exclusion from Automation
**Decision**: Dismissed tasks are filtered out of `listTasksInIClassStage`, which gates both `ListInFlightTasks` and `BackfillClosedServiceOrders`. When `IngestClosedServiceOrders` encounters a dismissed task, it mirrors the SO (audit trail) but skips all side-effects (stage move, activity, inventory).

**Why**: Dismissing a task signals operator intent to discard it. Continuing to stage-transition and comment would contradict that choice and confuse the operator.

---

### 2. Closed-by-IClass Flow Auto-Sets generalStatus
**Decision**: When the IClass closure loop transitions a task to a `hecho`-category stage (REQ-MOVE-1), it automatically sets `generalStatus='closed'` and records a system-attributed `status_changed` activity.

**Why**: Keeps management state consistent with workflow outcome. The system "closes" the task as part of the closure flow, not requiring separate API calls.

---

### 3. status_changed Activity Payload Normalized to Strings
**Decision**: All `status_changed` activities now carry string values (`'open'|'closed'|'dismissed'`), even when triggered by legacy `isClosed` boolean updates or system-triggered IClass closes.

**Why**: Unifies the event payload across manual and automated paths. Legacy activities (pre-generalStatus) with boolean values are gracefully handled by the renderer (no crashes, fallback labels work).

---

### 4. Bulk Close Gating via Bulk Action Bar
**Decision**: Closing/dismissing tasks in bulk via the bulk action bar is intentionally deferred. Individual close/dismiss actions are available in the detail view (`TaskHeader`).

**Why**: Bulk operations on status changes are higher-risk and require additional UI safeguards (confirmation modal, partial failure handling). The scope for #41 focused on individual task detail interactions.

---

### 5. Calendar View Exclusion
**Decision**: The Calendar view is untouched. Dismissed (and closed) tasks continue to appear on the Calendar, regardless of the status filter applied to Table/Kanban views.

**Why**: The Calendar is a timeline-centric view where completed/discarded tasks may still be relevant for historical context. Filtering them out would require a separate implementation and stakeholder decision.

---

## Test Coverage & Gates

### Backend Jest Tests (3260 passing)
- Task status transitions (open → closed, open → dismissed, closed → reopened, etc.)
- permission gating (scheduling.write required)
- Activity persistence (status_changed with string values)
- IClass integration (dismissed task exclusion, auto-close on hecho stage)
- Legacy isClosed boolean mapping
- In-memory and Prisma repository implementations

### Frontend vitest Tests (2369 passing)
- Status filter initialization and URL sync
- Status filter applied to API calls
- Status actions visibility and behavior
- Status badges rendering
- Permission-gated action visibility

### Type Checks
- tsc (backend): 0 errors
- vitest typecheck (frontend): 0 errors

---

## Deferred & Known Gaps

### 1. Calendar Status Filtering
The Calendar view was intentionally left unchanged. Dismissed tasks still appear. If this becomes a UX issue (operators report too much noise), thread the `generalStatus` filter through the Calendar query.

---

## Deployment & Rollback

### Production Deploy
- Pre-deploy verification:
  - Migration dry-run applied & rolled back successfully
  - Jest 3260/0 passed
  - tsc clean
  - vitest 2369/0 passed
  - FE typecheck clean

- Deployment steps:
  1. Deploy backend (Node + migration)
  2. Deploy frontend (React)
  3. Monitor logs for early errors

- Rollback plan:
  - Rollback migration: `npm run prisma:migrate resolve --rolled-back-to 202605...`
  - Redeploy previous backend/frontend commits
  - Verify data consistency post-rollback

---

## Review & QA History

### Adversarial Reviews (2 full sweeps)
- Review 1: Flagged Prisma NOT nullable relation on task.generalStatus (fixed: made non-nullable with default 'open')
- Review 2: Caught reprocess loop contamination (fixed: SetTaskGeneralStatus use case now isolated)

### Targeted Fixes
- **Prisma NOT Nullable Relation**: `generalStatus String @default("open")` ensures tasks always have a state
- **Reprocess Loop Contamination**: Separated SetTaskGeneralStatus from bulk update paths to prevent unintended field changes
- **Bulk Close Gating**: Confirmed in-scope; individual close/dismiss actions implemented, bulk operations deferred to future ticket

### Final QA Pass
- Manual testing of all three status transitions
- Verified FE filter defaults to `open`
- Confirmed dismissed tasks excluded from IClass automation
- Tested legacy isClosed boolean compatibility
- Checked activity feed renders legacy boolean events without crashing

---

## Artifacts

| Path | Purpose |
|------|---------|
| `/openspec/changes/archive/2026-06-11-task-general-status/` | Archived change folder with full proposal, design, specs, tasks |
| `/openspec/specs/scheduling/spec.md` | Updated with REQ-GS-FILTER-1, REQ-SHAPE-2 |
| `/openspec/specs/scheduling-tasks-views/spec.md` | Updated with FE filter/action/badge requirements |
| `/openspec/specs/task-activity/spec.md` | Updated with generalStatus activity semantics |
| `/openspec/specs/iclass-closure-loop/spec.md` | Updated with dismissed task handling |
| `/openspec/specs/task-general-status/spec.md` | NEW: Unified capability spec for task-general-status |

---

## Next Steps

No blockers. The feature is fully shipped and operational.

Future enhancements (post-ship):
- Bulk close/dismiss via bulk action bar
- Calendar view status filtering (if operators report noise)
- Dashboard metrics for dismissed vs closed vs open task counts

---

## Sign-Off

**SDD Cycle**: Complete  
**Specs**: Merged into main  
**Code**: Deployed to production  
**Status**: DONE
