-- Feature flag: contract-network-auto-assign (default OFF / dark by default).
-- El watcher (AutoAssignContractNetwork, gated en UispSyncScheduler) chequea este flag POR TICK;
-- ausente = deshabilitado, pero el seed lo hace flippeable desde la API/UI sin depender de un INSERT manual.
-- Idempotente (ON CONFLICT DO NOTHING) — mismo patrón que los seeds de flags existentes.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('contract-network-auto-assign', false, NOW())
ON CONFLICT ("key") DO NOTHING;
