-- Remediation (#20): re-audit all completed audits with the new full context.
-- The existing reprocess loop (auditDone=false AND auditAttempts < max) picks
-- them up. Replace-on-rerun keeps the prior audit until a new successful run.
--
-- Idempotency: WHERE auditDone = true means only currently-done rows are reset.
-- Running this again after re-audits have completed resets the newly-done rows —
-- acceptable one-time remediation; re-running on a subsequent deploy is harmless.
UPDATE "IClassServiceOrder" SET "auditDone" = false, "auditAttempts" = 0
WHERE "auditDone" = true;
