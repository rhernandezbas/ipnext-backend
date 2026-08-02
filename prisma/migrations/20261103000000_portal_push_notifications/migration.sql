-- portal-push-notifications — dispositivos push (FCM) por PortalAccount +
-- preferencia de notificaciones (avisos de servicio / promociones).
--
-- Additive only: 2 CREATE TABLE + indexes + FKs (Cascade), no DROP, no
-- backfill de datos existentes.
-- Seed appended below (molde 20261102000000_portal_promos): módulo RBAC
-- 'push' + permiso 'send' + grants a super_admin/administrador — calcado 1:1
-- de cómo se sembró promos.manage, todo ON CONFLICT DO NOTHING.
-- No BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia
-- transacción).

-- CreateTable
CREATE TABLE "PortalPushToken" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invalidAt" TIMESTAMP(3),

    CONSTRAINT "PortalPushToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalPushPreference" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "serviceAlerts" BOOLEAN NOT NULL DEFAULT true,
    "promos" BOOLEAN NOT NULL DEFAULT false,
    "promosOptInAt" TIMESTAMP(3),
    "promosOptInAppVersion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalPushPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PortalPushToken_token_key" ON "PortalPushToken"("token");

-- CreateIndex
CREATE INDEX "PortalPushToken_accountId_idx" ON "PortalPushToken"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalPushPreference_accountId_key" ON "PortalPushPreference"("accountId");

-- AddForeignKey
ALTER TABLE "PortalPushToken" ADD CONSTRAINT "PortalPushToken_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PortalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalPushPreference" ADD CONSTRAINT "PortalPushPreference_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PortalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Seed: módulo RBAC 'push' + permiso 'send' + grants (calcado de 'promos') ───

-- 1. Módulo
INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'push', 'Notificaciones push')
ON CONFLICT ("code") DO NOTHING;

-- 2. Permiso push.send ('send' YA existe en KNOWN_ACTIONS desde messaging-inbox F1 — se reusa, sin ALTER TYPE)
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'send'
FROM "RbacModule" m
WHERE m."code" = 'push'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 3. Grant push.send → super_admin + administrador (calcado de promos.manage — acción de alto riesgo/alcance)
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador')
  AND m."code" = 'push'
  AND p."action" = 'send'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
