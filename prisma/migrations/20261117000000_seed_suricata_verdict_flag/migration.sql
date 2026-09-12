-- Feature flag: suricata-verdict-enabled (default OFF — DARK).
--
-- design.md D0's flow diagram and D7.c both name a flag gate on the external
-- verdict router ("POST .../verdict  key dedicada + flag", "GET
-- .../attachments/:id/content ... con el mismo flag"), but the base migration
-- (20261116000000_suricata_tickets_mirror_base, D1.b) only seeded the OTHER
-- two flags this change needs ('suricata-sync-enabled', 'suricata-reply-enabled')
-- — this third one was missed there. Same incident as
-- 20261028000000_iclass_gps_ingest_flag: without this row, `SetFeatureFlag`
-- (an `update`, never an `upsert`) can NEVER turn it on from the flags UI —
-- the row can only be born from a migration.
--
-- Seeded FALSE on purpose: both external routes (verdict submission + D7.c
-- attachment content proxy) re-read this flag on every request, so a dark
-- seed changes zero observable behavior (the endpoint is already closed by
-- the dedicated token when unset — this is a SECOND, independent kill switch,
-- same "triple apagado" pattern as the sync scheduler).
--
-- Idempotente: ON CONFLICT DO NOTHING sobre el PK `key`. Sin BEGIN/COMMIT
-- explícito (Prisma envuelve cada migración en su propia transacción, regla
-- de 20261028000000_iclass_gps_ingest_flag).
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('suricata-verdict-enabled', false, NOW())
ON CONFLICT DO NOTHING;
