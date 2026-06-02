BEGIN;

-- Seed permission scheduling.iclass_manual_resend (idempotente).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'iclass_manual_resend'
FROM "RbacModule" m
WHERE m."code" = 'scheduling'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- Grant a super_admin (CROSS JOIN acotado, idempotente).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'scheduling'
  AND p."action" = 'iclass_manual_resend'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

COMMIT;
