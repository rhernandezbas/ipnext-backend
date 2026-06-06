-- SEED: feature flag gating the AI installation audit (closure loop F6).
-- Idempotent, default OFF. Replaces ICLASS_AUDIT_ENABLED as the on/off gate —
-- the operator flips it on from the UI; the env now only configures the Ollama model.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('iclass-audit', false, NOW())
ON CONFLICT ("key") DO NOTHING;
