-- SEED: feature flag gating the manual closure side-effect reprocess.
-- Idempotent, default OFF — the operator flips it on to allow re-firing pending
-- comment/inventory/audit effects on already-mirrored SOs.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('iclass-closure-reprocess', false, NOW())
ON CONFLICT ("key") DO NOTHING;
