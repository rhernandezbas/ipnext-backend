-- Migration: 20260801000200_plan_rbac
-- Seeds the 'plan' RBAC module + read/manage permissions +
-- grants them to 'super_admin' and 'administrador' roles.

INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'plan', 'Planes')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m WHERE m."code" = 'plan'
ON CONFLICT ("moduleId", "action") DO NOTHING;

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m WHERE m."code" = 'plan'
ON CONFLICT ("moduleId", "action") DO NOTHING;

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r CROSS JOIN "RbacPermission" p JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin' AND m."code" = 'plan' AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r CROSS JOIN "RbacPermission" p JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin' AND m."code" = 'plan' AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r CROSS JOIN "RbacPermission" p JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador' AND m."code" = 'plan' AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r CROSS JOIN "RbacPermission" p JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador' AND m."code" = 'plan' AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
