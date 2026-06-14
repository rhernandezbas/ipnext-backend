-- Ola A — Seed permission scheduling.iclass_close (idempotente).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'iclass_close'
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
  AND p."action" = 'iclass_close'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Ola B — Seed permission scheduling.iclass_assign (idempotente).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'iclass_assign'
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
  AND p."action" = 'iclass_assign'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- Feature flags — default OFF until validated in live environment (Ola A + B).
INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('iclass-close-action', false, NOW())
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "FeatureFlag" ("key", "enabled", "updatedAt")
VALUES ('iclass-assign-action', false, NOW())
ON CONFLICT ("key") DO NOTHING;
