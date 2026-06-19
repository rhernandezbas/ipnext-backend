-- Migration: ip_pool_allocator_columns_and_mercaccesosur_seed
--
-- ip-allocator (FindFreeIp): el allocator resuelve el pool de un NAS por (nasId, ipKind).
--   1) Agrega a IpPool las columnas `nasId` + `ipKind` (cgnat|public). Nullable → los pools
--      legacy no participan del allocator. Idempotente (IF NOT EXISTS).
--   2) Siembra las redes + pools de MercAccesoSur, CONDICIONAL a que exista el NAS
--      (ipAddress='10.60.0.38' o name='MercAccesoSur'). Idempotente (WHERE NOT EXISTS por
--      clave natural: la red por su CIDR, el pool por su nombre). Si el NAS no existe, no
--      siembra nada (deploy en entornos sin ese router no rompe).

BEGIN;

-- 1) Columnas del allocator en IpPool ------------------------------------------------
ALTER TABLE "IpPool" ADD COLUMN IF NOT EXISTS "nasId"  TEXT;
ALTER TABLE "IpPool" ADD COLUMN IF NOT EXISTS "ipKind" TEXT;

CREATE INDEX IF NOT EXISTS "IpPool_nasId_idx" ON "IpPool" ("nasId");

-- 2) Seed de MercAccesoSur (condicional a que exista el NAS) -------------------------

-- 2a) Red CGNAT 100.64.10.0/24 (gw 100.64.10.1)
INSERT INTO "IpNetwork" ("id", "name", "network", "status", "description", "gateway", "createdAt")
SELECT gen_random_uuid()::text, 'MercAccesoSur CGNAT', '100.64.10.0/24', 'active',
       'CGNAT de MercAccesoSur (ip-allocator)', '100.64.10.1', CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "NasServer" n
  WHERE n."ipAddress" = '10.60.0.38' OR n."name" = 'MercAccesoSur'
)
AND NOT EXISTS (
  SELECT 1 FROM "IpNetwork" WHERE "network" = '100.64.10.0/24'
);

-- 2b) Pool CGNAT usable 100.64.10.2 .. 100.64.10.254 (ligado al NAS, ipKind='cgnat')
INSERT INTO "IpPool" ("id", "networkId", "name", "rangeStart", "rangeEnd", "status", "nasId", "ipKind")
SELECT gen_random_uuid()::text, net."id", 'mercaccesosur-cgnat', '100.64.10.2', '100.64.10.254',
       'active', nas."id", 'cgnat'
FROM "IpNetwork" net
JOIN "NasServer" nas
  ON (nas."ipAddress" = '10.60.0.38' OR nas."name" = 'MercAccesoSur')
WHERE net."network" = '100.64.10.0/24'
AND NOT EXISTS (
  SELECT 1 FROM "IpPool" WHERE "name" = 'mercaccesosur-cgnat'
);

-- 2c) Red pública 190.7.247.0/24 (gw 190.7.247.1)
INSERT INTO "IpNetwork" ("id", "name", "network", "status", "description", "gateway", "createdAt")
SELECT gen_random_uuid()::text, 'MercAccesoSur público', '190.7.247.0/24', 'active',
       'IP pública de MercAccesoSur (ip-allocator)', '190.7.247.1', CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1 FROM "NasServer" n
  WHERE n."ipAddress" = '10.60.0.38' OR n."name" = 'MercAccesoSur'
)
AND NOT EXISTS (
  SELECT 1 FROM "IpNetwork" WHERE "network" = '190.7.247.0/24'
);

-- 2d) Pool público 190.7.247.2 .. 190.7.247.254 (ligado al NAS, ipKind='public')
INSERT INTO "IpPool" ("id", "networkId", "name", "rangeStart", "rangeEnd", "status", "nasId", "ipKind")
SELECT gen_random_uuid()::text, net."id", 'mercaccesosur-public', '190.7.247.2', '190.7.247.254',
       'active', nas."id", 'public'
FROM "IpNetwork" net
JOIN "NasServer" nas
  ON (nas."ipAddress" = '10.60.0.38' OR nas."name" = 'MercAccesoSur')
WHERE net."network" = '190.7.247.0/24'
AND NOT EXISTS (
  SELECT 1 FROM "IpPool" WHERE "name" = 'mercaccesosur-public'
);

COMMIT;
