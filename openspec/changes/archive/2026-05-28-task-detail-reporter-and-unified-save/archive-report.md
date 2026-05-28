# Archive Report: task-detail-reporter-and-unified-save

**Date Archived**: 2026-05-28
**Artifact Store**: hybrid (engram + openspec)
**Archive Path**: `openspec/changes/archive/2026-05-28-task-detail-reporter-and-unified-save/`

## SDD Cycle Complete

All phases PASSED. No CRITICAL or WARNING issues at archive time.

| Phase | Skill | Outcome |
|-------|-------|---------|
| Propose | sdd-propose | 3 in-scope deliverables (BE reporter default, FE unified save, FE Reporter column); 3 out-of-scope (no backfill, no DTO denorm, other header fields) |
| Spec | sdd-spec | 3 ADDED requirements to `scheduling` capability (REQ-CREATE-9, 10, 11) |
| Design | sdd-design | 3 architecture decisions with rejected alternatives (default in route, controlled editor lift, client-side resolver) |
| Tasks | sdd-tasks | 22 tasks across 5 phases (BE TDD / FE single save TDD / FE column TDD / commit-deploy / SDD close) |
| Apply | sdd-apply (Strict TDD) | 33 new tests across 6 files; BE 1152 passed, FE 1152 passed; 0 deviations from design |
| Verify | sdd-verify | Verdict **PASS**: 4/4 spec scenarios COMPLIANT; 10/10 informal FE deliverables COMPLIANT; 6/6 TDD compliance checks; 0 CRITICAL / 0 WARNING / 2 SUGGESTION |
| Archive | sdd-archive (this) | Delta merged into `openspec/specs/scheduling/spec.md`; folder moved to archive with date prefix |

## Source-of-Truth Sync

**Updated**: `openspec/specs/scheduling/spec.md`

Three new requirements ADDED to section **`## 4. Create Task`**, appended after REQ-CREATE-8, before the `---` separator that introduces section 5 (Update Task):

- **REQ-CREATE-9**: Reporter defaults to the authenticated user when omitted (with rationale on `User.id == admin.id` via JwtAuthAdapter).
- **REQ-CREATE-10**: Explicit reporterId in body wins over the default.
- **REQ-CREATE-11**: Defaulted reporter is still validated against the admin lookup (no special-casing).

All existing REQ-CREATE-1 through REQ-CREATE-8 preserved verbatim.

## Engram Artifact Trace (Observation IDs)

For cross-session traceability when the filesystem changes:

| Artifact | Topic Key | Engram ID |
|----------|-----------|-----------|
| Proposal | `sdd/task-detail-reporter-and-unified-save/proposal` | #255 |
| Spec (delta) | `sdd/task-detail-reporter-and-unified-save/spec` | #257 |
| Design | `sdd/task-detail-reporter-and-unified-save/design` | #258 |
| Tasks | `sdd/task-detail-reporter-and-unified-save/tasks` | #259 |
| Apply Progress | `sdd/task-detail-reporter-and-unified-save/apply-progress` | #260 |
| Verify Report | `sdd/task-detail-reporter-and-unified-save/verify-report` | #268 |

## Commits That Landed In Production

### Backend (ipnext-backend)
- `bb0d1cbe` — feat(scheduling): default reporter to authenticated user on task create
- `e0195409` — test(scheduling): guard UpdateTaskSchema FK nullability contract

### Frontend (ipnext-frontend)
- `a1e35cc` — feat(scheduling): unified save in task detail + Reporter column in tasks list
- `7bd1ed5` — fix(scheduling): backfill new catalog columns into stored visible list
- `fdcafbd` — fix(scheduling): show error toast on failed unified save instead of unhandled rejection
- `12a6589` — fix(scheduling): normalise empty FK selects to null in unified save payload
- `a4cce51` — fix(scheduling): use full admin catalog (not just technicians) to resolve Reporter column

Five FE commits because verification in prod surfaced four real-world issues that pure tests could not catch:
1. localStorage of existing users did not include the new column key (backfill needed).
2. The unified handler had no try/catch — 400s arrived as unhandled console errors.
3. The "Sin asignar" `<option value="">` produced an empty string that failed `min(1)` validation on the BE schema.
4. The Reporter resolver was wired to `useTechnicians()` (role-filtered) instead of `useAdmins()` (all roles).

These were caught DURING prod verification and corrected before this archive. They are now part of the SDD trace as historical lessons — not failures, signals of why prod verification matters even when tests are green.

## Lessons Worth Carrying Forward

1. **TDD surfaced two latent assumptions before commit**: the REQ-STAGE-DEFAULT-1 ad-hoc app outside `buildApp` (had its own `emptyLookup`) and the `applyTaskVariables` function attached to the old `handleDescSave` — both would have been lost in the refactor without the failing-test signal.
2. **Prod verification surfaced four issues unit/integration tests could not**: localStorage persistence quirk, error UX, empty-string vs null at the API boundary, role-filtered admin catalog. All addressable but only visible against real data and real user actions.
3. **The contract guard on `UpdateTaskSchema` (#268)** discovered an existing asymmetry: `projectId` lacks `min(1)` while the FK ids carry it. Documented inline in the test so future drift cannot silently change the contract.

## Verdict

✅ **CLOSED**. The change is fully planned, implemented, verified, deployed, and archived.
