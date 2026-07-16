-- Migration: 20260916000100_contract_network_assign_permission
-- Seeds the 'contracts.assign' RBAC permission (contract-node-ap-auto-assign, Fase B — picker
-- manual del nodo/AP de un contrato) + grants it to 'super_admin' and 'administrador' roles.
-- The 'contracts' module already exists (service-technology, 20260530040000_service_technology)
-- — re-INSERT here is idempotent so this migration also works against a fresh DB.
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING throughout.
-- No explicit transaction block (Prisma wraps each migration in its own transaction).

-- ─── 1. Re-seed the contracts module (idempotent — fresh-DB safety net) ─────

INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'contracts', 'Contratos')
ON CONFLICT ("code") DO NOTHING;

-- ─── 2. Seed contracts.assign permission ─────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'assign'
FROM "RbacModule" m
WHERE m."code" = 'contracts'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 3. Grant contracts.assign to super_admin ────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'contracts'
  AND p."action" = 'assign'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 4. Grant contracts.assign to administrador ──────────────────────────────
-- (design §14.7 — corrección: "administrador" es el equivalente RBAC-system de "admin";
-- no existe un RbacRole con code 'admin' en este sistema.)

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'contracts'
  AND p."action" = 'assign'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
