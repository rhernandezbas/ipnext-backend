-- Migration: drop_admin_activity_log (SDD #4 Phase 3b)
-- AdminActivityLog superseded by AuditEvent. Legacy history DISCARDED (MVP decision).
BEGIN;
DROP TABLE IF EXISTS "AdminActivityLog";
COMMIT;
