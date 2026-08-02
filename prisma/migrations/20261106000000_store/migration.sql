-- store-backend — tienda del ISP dentro de la app de clientes. El staff carga
-- productos (StoreProduct) en Prominense; el cliente pide con "Lo quiero"
-- (1 pago o cuotas EN LA FACTURA, sin pasarela en v1) y el pedido queda como
-- StoreOrder, snapshot inmutable del precio y las cuotas elegidas, ligado al
-- Ticket que coordina la entrega.
--
-- Additive only: 2 CREATE TABLE + indexes + FKs (Restrict/Cascade/SetNull),
-- no DROP, no backfill de datos existentes.
-- Seed appended below (molde 20261102000000_portal_promos /
-- 20261104000000_wifi_self_service_permissions): módulo RBAC 'store' +
-- permisos + grants, calcado 1:1 — todo ON CONFLICT DO NOTHING.
-- No BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia
-- transacción).

-- CreateTable
CREATE TABLE "StoreProduct" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceArs" DECIMAL(12,2) NOT NULL,
    "maxInstallments" INTEGER NOT NULL DEFAULT 1,
    "warrantyText" TEXT NOT NULL,
    "badge" TEXT,
    "imageStorageKey" TEXT,
    "ticketAreaId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreOrder" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "contractId" TEXT,
    "installments" INTEGER NOT NULL,
    "priceArsAtOrder" DECIMAL(12,2) NOT NULL,
    "ticketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StoreProduct_active_idx" ON "StoreProduct"("active");

-- CreateIndex
CREATE INDEX "StoreProduct_archivedAt_idx" ON "StoreProduct"("archivedAt");

-- CreateIndex
CREATE INDEX "StoreProduct_ticketAreaId_idx" ON "StoreProduct"("ticketAreaId");

-- CreateIndex
CREATE INDEX "StoreOrder_productId_idx" ON "StoreOrder"("productId");

-- CreateIndex
CREATE INDEX "StoreOrder_clientId_idx" ON "StoreOrder"("clientId");

-- CreateIndex
CREATE INDEX "StoreOrder_contractId_idx" ON "StoreOrder"("contractId");

-- CreateIndex
CREATE INDEX "StoreOrder_ticketId_idx" ON "StoreOrder"("ticketId");

-- AddForeignKey
ALTER TABLE "StoreProduct" ADD CONSTRAINT "StoreProduct_ticketAreaId_fkey" FOREIGN KEY ("ticketAreaId") REFERENCES "TicketAreaCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict (no Cascade/SetNull): un producto con pedidos ya hechos NO se
-- puede borrar hard-delete (tampoco hay endpoint para eso hoy — solo
-- archivar) sin antes resolver qué pasa con su historial de pedidos.
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_productId_fkey" FOREIGN KEY ("productId") REFERENCES "StoreProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreOrder" ADD CONSTRAINT "StoreOrder_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Seed: módulo RBAC 'store' + permisos + grants (calcado de 'promos'/'wifi') ───

-- 1. Módulo
INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'store', 'Tienda')
ON CONFLICT ("code") DO NOTHING;

-- 2. Permiso store.read
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m
WHERE m."code" = 'store'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 3. Permiso store.manage
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'store'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 4. Grant store.read → los 6 roles de sistema (calcado de promos.read/wifi.read)
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador', 'administracion', 'ventas', 'noc', 'tecnico')
  AND m."code" = 'store'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 5. Grant store.manage → super_admin + administrador (calcado de promos.manage/wifi.manage)
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador')
  AND m."code" = 'store'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
