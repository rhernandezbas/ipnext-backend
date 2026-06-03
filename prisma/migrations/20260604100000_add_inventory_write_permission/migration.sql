BEGIN;

-- 1. Crear el permiso inventory.write (idempotente — probablemente ya sembrado por la foundation).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'write'
FROM "RbacModule" m
WHERE m."code" = 'inventory'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 2. Otorgar inventory.read + inventory.write a tecnico, administrador, super_admin (idempotente).
--    Roles operativos del inventario. read incluido para que la migración clients.*→inventory.*
--    no deje sin LECTURA a quien hoy ve el inventario del contrato.
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('tecnico', 'administrador', 'super_admin')
  AND m."code" = 'inventory'
  AND p."action" IN ('read', 'write')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
