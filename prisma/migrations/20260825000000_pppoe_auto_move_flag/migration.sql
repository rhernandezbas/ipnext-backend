-- Feature flag: pppoe-auto-move (default OFF).
-- El watcher de auto-move de PPPoE (PppoeAutoMoveScheduler, pppoe-move-nas W2) arranca DARK:
-- lee este flag EN CADA tick y, si está OFF, no procesa. Sin este seed el flag NO existe en la
-- tabla FeatureFlag, por lo que la UI de feature flags no lo muestra y el operador no puede
-- activarlo. Mismo patrón que 'radius-auth-ingest' (20260814000100_radius_auth_ingest_flag).
-- Idempotente: ON CONFLICT DO NOTHING sobre el PK key.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('pppoe-auto-move', false, NOW())
ON CONFLICT DO NOTHING;
