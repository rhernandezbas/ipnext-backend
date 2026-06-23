-- Feature flag: radius-accounting-ingest (default OFF).
-- El scheduler de ingesta de accounting (RadiusAccountingIngestScheduler) arranca DARK:
-- lee este flag y, si está OFF, no ingesta. Sin este seed el flag NO existe en la tabla
-- FeatureFlag, por lo que la UI de feature flags no lo muestra y el operador no puede
-- activarlo. Mismo patrón que 'uisp-sync' (20260619000000_uisp_mirror).
-- Idempotente: ON CONFLICT DO NOTHING sobre el PK key.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('radius-accounting-ingest', false, NOW())
ON CONFLICT DO NOTHING;
