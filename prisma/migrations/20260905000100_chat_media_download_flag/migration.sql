-- Feature flag: chat-media-download (default OFF).
-- ChatMediaDownloadScheduler (MEDIA-3) arranca DARK: lee este flag y, si está OFF, no
-- barre. Sin este seed el flag NO existe en la tabla FeatureFlag, por lo que la UI de
-- feature flags no lo muestra y el operador no puede activarlo. Mismo patrón que
-- 'radius-auth-ingest' (20260814000100_radius_auth_ingest_flag).
-- Idempotente: ON CONFLICT DO NOTHING sobre el PK key.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('chat-media-download', false, NOW())
ON CONFLICT DO NOTHING;
