-- #86 — RBAC: scheduling.hard_delete (borrado total de tareas, solo super_admin).
-- Aditivo e idempotente. No BEGIN/COMMIT (Prisma envuelve cada migración en su propia transacción).
-- Mirror del patrón de 20260604010000_rbac_iclass_manual_resend: super_admin-only.

-- Seed permission scheduling.hard_delete (idempotente).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'hard_delete'
FROM "RbacModule" m
WHERE m."code" = 'scheduling'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- Grant SOLO a super_admin (CROSS JOIN acotado, idempotente).
-- Ningun otro rol recibe hard_delete -> el DELETE total queda restringido a super_admin.
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'scheduling'
  AND p."action" = 'hard_delete'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
