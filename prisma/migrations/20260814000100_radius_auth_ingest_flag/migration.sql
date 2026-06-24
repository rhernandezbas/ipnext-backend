-- Feature flag: radius-auth-ingest (default OFF).
-- El scheduler de ingesta de eventos de auth (RadiusAuthIngestScheduler) arranca DARK:
-- lee este flag y, si está OFF, no ingesta. Sin este seed el flag NO existe en la tabla
-- FeatureFlag, por lo que la UI de feature flags no lo muestra y el operador no puede
-- activarlo. Mismo patrón que 'radius-accounting-ingest' (20260812000200_radius_accounting_ingest_flag).
-- Idempotente: ON CONFLICT DO NOTHING sobre el PK key.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('radius-auth-ingest', false, NOW())
ON CONFLICT DO NOTHING;
