-- CreateEnum
CREATE TYPE "RbacAction" AS ENUM ('read', 'write', 'delete', 'manage');

-- CreateTable
CREATE TABLE "RbacModule" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RbacModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacPermission" (
    "id" TEXT NOT NULL,
    "moduleId" TEXT NOT NULL,
    "action" "RbacAction" NOT NULL,

    CONSTRAINT "RbacPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacRole" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RbacRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacUser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "RbacUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RbacUserRole" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RbacUserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "RbacRolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RbacRolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "RbacModule_code_key" ON "RbacModule"("code");

-- CreateIndex
CREATE INDEX "RbacPermission_moduleId_idx" ON "RbacPermission"("moduleId");

-- CreateIndex
CREATE UNIQUE INDEX "RbacPermission_moduleId_action_key" ON "RbacPermission"("moduleId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "RbacRole_code_key" ON "RbacRole"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RbacUser_email_key" ON "RbacUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RbacUser_login_key" ON "RbacUser"("login");

-- CreateIndex
CREATE INDEX "RbacUser_login_idx" ON "RbacUser"("login");

-- CreateIndex
CREATE INDEX "RbacUserRole_roleId_idx" ON "RbacUserRole"("roleId");

-- CreateIndex
CREATE INDEX "RbacRolePermission_permissionId_idx" ON "RbacRolePermission"("permissionId");

-- AddForeignKey
ALTER TABLE "RbacPermission" ADD CONSTRAINT "RbacPermission_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "RbacModule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacUserRole" ADD CONSTRAINT "RbacUserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "RbacUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacUserRole" ADD CONSTRAINT "RbacUserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "RbacRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacRolePermission" ADD CONSTRAINT "RbacRolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "RbacRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RbacRolePermission" ADD CONSTRAINT "RbacRolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "RbacPermission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- =============================================================
-- SEED: Catalog data (idempotent — all INSERTs use ON CONFLICT DO NOTHING)
-- =============================================================

-- Seed: 14 RbacModule rows
INSERT INTO "RbacModule" ("id", "code", "label", "createdAt") VALUES
  (gen_random_uuid(), 'clients',     'Clientes',       NOW()),
  (gen_random_uuid(), 'billing',     'Facturación',    NOW()),
  (gen_random_uuid(), 'scheduling',  'Agendamiento',   NOW()),
  (gen_random_uuid(), 'network',     'Red',            NOW()),
  (gen_random_uuid(), 'admin',       'Administración', NOW()),
  (gen_random_uuid(), 'monitoring',  'Monitoreo',      NOW()),
  (gen_random_uuid(), 'iclass',      'IClass',         NOW()),
  (gen_random_uuid(), 'gestionReal', 'Gestión Real',   NOW()),
  (gen_random_uuid(), 'reports',     'Reportes',       NOW()),
  (gen_random_uuid(), 'tickets',     'Tickets',        NOW()),
  (gen_random_uuid(), 'settings',    'Configuración',  NOW()),
  (gen_random_uuid(), 'crm',         'CRM',            NOW()),
  (gen_random_uuid(), 'inventory',   'Inventario',     NOW()),
  (gen_random_uuid(), 'vehicles',    'Vehículos',      NOW())
ON CONFLICT (code) DO NOTHING;

-- Seed: 56 RbacPermission rows (14 modules × 4 actions via CROSS JOIN)
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT
  gen_random_uuid(),
  m.id,
  a.action::"RbacAction"
FROM "RbacModule" m
CROSS JOIN (
  VALUES ('read'), ('write'), ('delete'), ('manage')
) AS a(action)
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- Seed: 6 system roles
INSERT INTO "RbacRole" ("id", "code", "label", "description", "isSystem", "createdAt", "updatedAt") VALUES
  (gen_random_uuid(), 'super_admin',    'Super Administrador', NULL,                      true, NOW(), NOW()),
  (gen_random_uuid(), 'administrador',  'Administrador',       'Dueño/jefe del negocio',  true, NOW(), NOW()),
  (gen_random_uuid(), 'administracion', 'Administración',      'Contabilidad',            true, NOW(), NOW()),
  (gen_random_uuid(), 'ventas',         'Ventas',              NULL,                      true, NOW(), NOW()),
  (gen_random_uuid(), 'noc',            'NOC',                 NULL,                      true, NOW(), NOW()),
  (gen_random_uuid(), 'tecnico',        'Técnico',             NULL,                      true, NOW(), NOW())
ON CONFLICT (code) DO NOTHING;

-- Seed: super_admin gets all 56 permissions (other roles get 0 rows — configured from UI)
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r.id, p.id, NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
WHERE r.code = 'super_admin'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
