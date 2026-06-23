-- ne8000-nas-registration: idempotent seed — registra el BRAS Huawei NE8000-1 como NasServer.
-- nasIpAddress = '10.75.0.30' (confirmado Phase 0, 2026-06-22).
-- WHERE NOT EXISTS: idempotente de verdad SIN necesitar un UNIQUE en nasIpAddress
-- (NasServer.nasIpAddress no es @unique; un ON CONFLICT DO NOTHING apuntaría al PK
--  gen_random_uuid() que nunca colisiona → duplicaría en cada corrida). Re-correr = no-op.
INSERT INTO "NasServer" (
  "id", "name", "type", "ipAddress", "nasIpAddress",
  "status", "clientCount", "description", "createdAt"
)
SELECT
  gen_random_uuid(),
  'NE8000-1',
  'huawei_radius',
  '10.75.0.30',
  '10.75.0.30',
  'active',
  0,
  'Huawei NE8000-1 BRAS — PPPoE Acceso Sur (terminación RADIUS HA)',
  now()
WHERE NOT EXISTS (
  SELECT 1 FROM "NasServer" WHERE "nasIpAddress" = '10.75.0.30'
);
