-- Migration: 20260731010000_pppoe_cut_permission
-- Fase C (enforcement) — seed del permiso 'pppoe.cut' (corte de servicio) +
-- grant a 'super_admin' y 'administrador'. El módulo 'pppoe' ya existe (20260730).
-- Idempotente: INSERT ... ON CONFLICT DO NOTHING en todo.
-- Sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su transacción).

-- ─── 1. Seed pppoe.cut permission ────────────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'cut'
FROM "RbacModule" m
WHERE m."code" = 'pppoe'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 2. Grant pppoe.cut to super_admin ───────────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'pppoe'
  AND p."action" = 'cut'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 3. Grant pppoe.cut to administrador ─────────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'pppoe'
  AND p."action" = 'cut'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
