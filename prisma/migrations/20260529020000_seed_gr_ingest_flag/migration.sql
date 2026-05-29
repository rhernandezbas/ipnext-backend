-- Seed the master switch for the Gestión Real installation-order ingest.
-- Deploy runs `migrate deploy` (NOT `db seed`), so the flag must be seeded here.
-- Idempotent: an existing value (e.g. toggled on in prod) is preserved.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('gestion-real-ingest', false, NOW())
ON CONFLICT ("key") DO NOTHING;
