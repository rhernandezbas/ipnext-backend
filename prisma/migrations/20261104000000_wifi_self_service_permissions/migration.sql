-- wifi-self-service (F0) — permisos RBAC del self-service de WiFi (ONUs
-- Huawei fibra). NO hay tablas nuevas en F0: el vínculo ONU<->contrato vive
-- en ContractInstalledItem (ya existe) y el estado vive en SmartOLT (nunca un
-- campo "validador" duplicado, ver proposal.md regla 3).
--
-- Seed ON CONFLICT DO NOTHING, calcado 1:1 de cómo se sembró
-- promos.read/promos.manage (20261102000000_portal_promos), que a su vez
-- calca 'news' / molde messaging_permissions.
-- No BEGIN/COMMIT explícito (Prisma envuelve cada migración en su propia
-- transacción).

-- 1. Módulo
INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'wifi', 'WiFi (self-service)')
ON CONFLICT ("code") DO NOTHING;

-- 2. Permiso wifi.read
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'read'
FROM "RbacModule" m
WHERE m."code" = 'wifi'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 3. Permiso wifi.manage
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", 'manage'
FROM "RbacModule" m
WHERE m."code" = 'wifi'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 4. Grant wifi.read → los 6 roles de sistema (calcado de promos.read/news.read)
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador', 'administracion', 'ventas', 'noc', 'tecnico')
  AND m."code" = 'wifi'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 5. Grant wifi.manage → super_admin + administrador (calcado de promos.manage/news.manage)
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador')
  AND m."code" = 'wifi'
  AND p."action" = 'manage'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
