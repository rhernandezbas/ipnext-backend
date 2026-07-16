-- install-pppoe-pregen (K1): pre-generación de credenciales PPPoE en instalaciones de GR.

-- 1) GestionRealIngestConfig.pppoeProfile (TEXT, NULLABLE): grupo/plan RADIUS
--    (radusergroup) usado al pre-provisionar el PPPoE de una instalación ingestada.
--    No hay mapping determinístico plan GR ("300MB", "50/25MB") → grupo RADIUS ("IP-*"),
--    así que es un default configurable en runtime (mismo patrón que fiber/wirelessProjectId).
--    NULL = sin configurar → la pre-generación degrada a no-op aunque el flag esté ON.
ALTER TABLE "GestionRealIngestConfig" ADD COLUMN "pppoeProfile" TEXT;

-- 2) Feature flag 'install-pppoe-pregen' (default OFF — rollout oscuro). El ingest lo
--    chequea POR RUN; sin este seed el flag NO existe en la tabla FeatureFlag, la UI de
--    feature flags no lo muestra y el operador no puede prenderlo (el PATCH de flags usa
--    update, no upsert — lección aprendida). Mismo patrón que 'radius-auto-cure'
--    (20260917000100_radius_auto_cure_flag). Idempotente: ON CONFLICT DO NOTHING sobre el PK key.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('install-pppoe-pregen', false, NOW())
ON CONFLICT DO NOTHING;
