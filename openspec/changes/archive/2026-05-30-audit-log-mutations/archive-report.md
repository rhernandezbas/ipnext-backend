# Archive Report — audit-log-mutations (SDD #4)

**Archived: 2026-05-30** · Verdict: PASS · Shipped to production.

## What shipped
Generic mutation audit log replacing the hand-curated AdminActivityLog. Every
POST/PUT/PATCH/DELETE under /api is recorded to `AuditEvent` (actor, method,
path, masked before/after, status, ip) via a global middleware, with faithful
before/after `AuditService.emit` for SET_ROLE_PERMISSIONS. New "Actividad" tab
(ActivityBody) consumes GET /api/admin/audit-events with filters + a diff drawer.
Legacy AdminActivityLog (model, route, use case, repo method, FE type/hook) removed.

## Commits
- Backend (ipnext-backend): 94abfef6 (plan), 12944202 (P1), 55eaecba (P2), 78bcb76c (P3a), 516e96e7 (P3b), + timestamp-bump chore. Deployed via push (run 26670876926).
- Frontend (ipnext-frontend): 291581d (P4). Deployed (run 26671036068).

## Migrations (applied in prod)
- 20260529221000_audit_event — additive (CREATE AuditEvent + 4 indexes + FK SET NULL).
- 20260529230000_drop_admin_activity_log — destructive (DROP TABLE AdminActivityLog; legacy history discarded).

## Spec synced
Canonical capability spec written to openspec/specs/audit-log/spec.md.

## Follow-ups (deferred)
Retention/purge policy; async audit writes at scale; `to` filter day-granularity nuance.
