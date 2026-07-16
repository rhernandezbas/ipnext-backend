-- internal-news — tablón interno del equipo (BE Batch 1)
-- Generated via: prisma migrate diff --from-schema <HEAD schema.prisma> --to-schema <working schema.prisma> --script
-- Additive only: 3 CREATE TABLE + indexes + FKs (Restrict/SetNull/Cascade), no DROP, no backfill.
-- Seed appended below (molde 20260704000000_ticket_area_catalog + 20260904000100_messaging_permissions):
-- categorías iniciales + módulo RBAC 'news' + permisos + grants, todo ON CONFLICT DO NOTHING.
-- No BEGIN/COMMIT (Prisma wraps each migration in its own transaction).

-- CreateTable
CREATE TABLE "NewsCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsPost" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorName" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsReadReceipt" (
    "id" TEXT NOT NULL,
    "newsPostId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsReadReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NewsCategory_name_key" ON "NewsCategory"("name");

-- CreateIndex
CREATE INDEX "NewsPost_categoryId_idx" ON "NewsPost"("categoryId");

-- CreateIndex
CREATE INDEX "NewsPost_archivedAt_idx" ON "NewsPost"("archivedAt");

-- CreateIndex
CREATE INDEX "NewsPost_pinned_publishedAt_idx" ON "NewsPost"("pinned", "publishedAt");

-- CreateIndex
CREATE INDEX "NewsReadReceipt_userId_idx" ON "NewsReadReceipt"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NewsReadReceipt_newsPostId_userId_key" ON "NewsReadReceipt"("newsPostId", "userId");

-- AddForeignKey
ALTER TABLE "NewsPost" ADD CONSTRAINT "NewsPost_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "NewsCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsPost" ADD CONSTRAINT "NewsPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "RbacUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsReadReceipt" ADD CONSTRAINT "NewsReadReceipt_newsPostId_fkey" FOREIGN KEY ("newsPostId") REFERENCES "NewsPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsReadReceipt" ADD CONSTRAINT "NewsReadReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "RbacUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Seed: 4 categorías iniciales (idempotente — ON CONFLICT ("name") DO NOTHING) ─────────────

INSERT INTO "NewsCategory" ("id", "name", "color", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'Red/Infraestructura', '#6366f1', NOW(), NOW()),
  (gen_random_uuid(), 'Campañas',            '#f59e0b', NOW(), NOW()),
  (gen_random_uuid(), 'Comercial',           '#10b981', NOW(), NOW()),
  (gen_random_uuid(), 'General',             '#64748b', NOW(), NOW())
ON CONFLICT ("name") DO NOTHING;

-- ─── Seed: módulo RBAC 'news' + permisos + grants (molde messaging_permissions) ───────────────

-- 1. Módulo
INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'news', 'Noticias')
ON CONFLICT ("code") DO NOTHING;

-- 2. Permiso news.read
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m
WHERE m."code" = 'news'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 3. Permiso news.manage
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'news'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 4. Grant news.read → los 6 roles de sistema
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador', 'administracion', 'ventas', 'noc', 'tecnico')
  AND m."code" = 'news'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 5. Grant news.manage → super_admin + administrador
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador')
  AND m."code" = 'news'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
