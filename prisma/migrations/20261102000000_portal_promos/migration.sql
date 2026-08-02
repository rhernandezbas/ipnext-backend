-- portal-promos — promociones publicadas por el operador para la app de
-- clientes. El operador elige a quién le llegan (segment, MISMO shape que
-- CampaignSegmentFilter); el cliente las ve en Inicio y puede tocar el CTA,
-- lo que abre un reclamo (Ticket) con el contrato adjunto.
--
-- Additive only: 2 CREATE TABLE + indexes + FKs (Cascade/SetNull), no DROP,
-- no backfill de datos existentes.
-- Seed appended below (molde 20260911000000_internal_news +
-- 20260904000100_messaging_permissions): módulo RBAC 'promos' + permisos +
-- grants, calcado 1:1 de cómo se sembró news.read/news.manage — todo
-- ON CONFLICT DO NOTHING.
-- No BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia
-- transacción).

-- CreateTable
CREATE TABLE "PortalPromo" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageStorageKey" TEXT,
    "ctaLabel" TEXT NOT NULL DEFAULT 'Me interesa',
    "ticketAreaId" TEXT,
    "segment" JSONB NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalPromo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalPromoResponse" (
    "id" TEXT NOT NULL,
    "promoId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ticketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalPromoResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PortalPromo_publishedAt_idx" ON "PortalPromo"("publishedAt");

-- CreateIndex
CREATE INDEX "PortalPromo_archivedAt_idx" ON "PortalPromo"("archivedAt");

-- CreateIndex
CREATE INDEX "PortalPromo_ticketAreaId_idx" ON "PortalPromo"("ticketAreaId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalPromoResponse_ticketId_key" ON "PortalPromoResponse"("ticketId");

-- CreateIndex
CREATE INDEX "PortalPromoResponse_clientId_idx" ON "PortalPromoResponse"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalPromoResponse_promoId_clientId_key" ON "PortalPromoResponse"("promoId", "clientId");

-- AddForeignKey
ALTER TABLE "PortalPromo" ADD CONSTRAINT "PortalPromo_ticketAreaId_fkey" FOREIGN KEY ("ticketAreaId") REFERENCES "TicketAreaCatalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalPromo" ADD CONSTRAINT "PortalPromo_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalPromoResponse" ADD CONSTRAINT "PortalPromoResponse_promoId_fkey" FOREIGN KEY ("promoId") REFERENCES "PortalPromo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalPromoResponse" ADD CONSTRAINT "PortalPromoResponse_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalPromoResponse" ADD CONSTRAINT "PortalPromoResponse_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Seed: módulo RBAC 'promos' + permisos + grants (calcado de 'news', molde messaging_permissions) ───

-- 1. Módulo
INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'promos', 'Promociones')
ON CONFLICT ("code") DO NOTHING;

-- 2. Permiso promos.read
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m
WHERE m."code" = 'promos'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 3. Permiso promos.manage
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'promos'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 4. Grant promos.read → los 6 roles de sistema (calcado de news.read)
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador', 'administracion', 'ventas', 'noc', 'tecnico')
  AND m."code" = 'promos'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 5. Grant promos.manage → super_admin + administrador (calcado de news.manage)
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador')
  AND m."code" = 'promos'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
