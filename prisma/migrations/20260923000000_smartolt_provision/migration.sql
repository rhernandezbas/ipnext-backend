-- smartolt-provision (K2): aprovisionamiento automático de ONUs fibra Huawei vía SmartOLT.

-- 1) Catálogo local de OLTs SmartOLT: VLAN de servicio default + VLAN de management.
--    "serviceVlanDefault" NULL = sin default (CHIVILCOY X2: VLAN heterogénea por cliente —
--    el operador la elige SIEMPRE). "mgmtVlan" NULL = desconocida → el paso mgmt IP se salta.
CREATE TABLE IF NOT EXISTS "SmartOltOltConfig" (
    "id" TEXT NOT NULL,
    "smartoltOltId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceVlanDefault" INTEGER,
    "mgmtVlan" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmartOltOltConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SmartOltOltConfig_smartoltOltId_key" ON "SmartOltOltConfig"("smartoltOltId");

-- 2) Seed con los valores EMPÍRICOS verificados contra la instancia (skill smartolt-ipnext):
--      MERCEDES1    (olt "1"): VLAN servicio 246, mgmt 11
--      CHIVILCOY X2 (olt "3"): SIN default (heterogénea por cliente), mgmt desconocida
--      Estudiantes  (olt "5"): VLAN servicio 229, mgmt 12
--      AGOTE X2     (olt "7"): VLAN servicio 331, mgmt desconocida
--    Ids determinísticos (no uuid) para que el seed sea legible e idempotente.
--    Idempotente: ON CONFLICT DO NOTHING sobre el unique smartoltOltId — un re-run
--    o un valor ya editado en runtime JAMÁS se pisa.
INSERT INTO "SmartOltOltConfig" ("id", "smartoltOltId", "name", "serviceVlanDefault", "mgmtVlan", "updatedAt")
VALUES
    ('smartolt-olt-1', '1', 'MERCEDES1', 246, 11, NOW()),
    ('smartolt-olt-3', '3', 'CHIVILCOY X2', NULL, NULL, NOW()),
    ('smartolt-olt-5', '5', 'Estudiantes', 229, 12, NOW()),
    ('smartolt-olt-7', '7', 'AGOTE X2', 331, NULL, NOW())
ON CONFLICT ("smartoltOltId") DO NOTHING;

-- 3) Feature flag 'fiber-auto-provision' (default OFF — rollout oscuro, botón-driven).
--    Sin este seed el flag NO existe en la tabla y el PATCH de flags no puede prenderlo
--    (usa update, no upsert — lección install-pppoe-pregen). Idempotente.
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('fiber-auto-provision', false, NOW())
ON CONFLICT DO NOTHING;
