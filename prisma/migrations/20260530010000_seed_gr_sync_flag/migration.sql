-- Seed the master switch for the Gestión Real client sync.
-- Deploy runs `migrate deploy` (NOT `db seed`), so the flag must be seeded here.
-- Seeded TRUE: the client sync is LIVE in prod today, so a false default would
-- silently stop it on deploy (a regression). The flag becomes the operator's
-- live kill switch. Idempotent: an existing value (e.g. toggled in prod) is preserved.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('gestion-real-sync', true, NOW())
ON CONFLICT ("key") DO NOTHING;
