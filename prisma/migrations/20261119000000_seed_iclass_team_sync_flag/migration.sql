-- SEED: feature flag gating the periodic IClass team catalog sync.
-- Idempotent. Seeded ON (explicit operator decision, 2026-09-23): the catalog had
-- not been synced since 2026-06-17 and was offering cancelled IClass teams.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('iclass-team-sync', true, NOW())
ON CONFLICT ("key") DO NOTHING;
