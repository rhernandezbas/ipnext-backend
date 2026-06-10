BEGIN;

-- Seed permission admin.flags (idempotent).
-- This sub-action guards PATCH /api/admin/feature-flags/:key (flag toggle).
-- GETs remain auth-only. Only super_admin holds this until roles are assigned.
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'flags'
FROM "RbacModule" m
WHERE m."code" = 'admin'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- Grant admin.flags to super_admin (idempotent — mirrors rbac_iclass_manual_resend pattern).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'admin'
  AND p."action" = 'flags'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
