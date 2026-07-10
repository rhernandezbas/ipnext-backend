-- service-transfer — permisos granulares de transferencia (data-only, aditiva, idempotente).
-- Prisma wraps each migration in its own transaction; no BEGIN/COMMIT here.
--
-- Accion nueva 'transfer' en tv / pppoe / inventory (boton "Transferir a otro cliente").
-- Mismo patron que 20260705000000_tv_granular_permissions: seed de RbacPermission + grant a
-- super_admin (sentinel '*', se otorga por consistencia) y administrador (rol operativo full).

-- ============================================================
-- 1. Seed tv:transfer / pppoe:transfer / inventory:transfer
-- ============================================================
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'transfer'
FROM "RbacModule" m
WHERE m."code" IN ('tv', 'pppoe', 'inventory')
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ============================================================
-- 2. Grant a super_admin y administrador
-- ============================================================
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE m."code" IN ('tv', 'pppoe', 'inventory')
  AND p."action" = 'transfer'
  AND r."code" IN ('super_admin', 'administrador')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
