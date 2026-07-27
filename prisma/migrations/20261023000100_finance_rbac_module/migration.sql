-- finance-growth-dashboard Fase 1 — módulo RBAC 'finance' (design.md Decision
-- 6: DELIBERADAMENTE separado de 'billing', el cementerio Splynx). No toca
-- ninguna tabla ni fila existente de billing/monitoring/etc. Molde
-- 20260911000000_internal_news (seed de módulo + permisos + grants). No
-- BEGIN/COMMIT (Prisma envuelve cada migración en su propia transacción).

-- 1. Módulo
INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'finance', 'Finanzas — Crecimiento')
ON CONFLICT ("code") DO NOTHING;

-- 2. Permisos: read, manage_costs, manage_targets, manage_inflation, sync
--    ('sync' ya existe como action code — se reusa, no se duplica).
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", a."action"
FROM "RbacModule" m
CROSS JOIN (VALUES ('read'), ('manage_costs'), ('manage_targets'), ('manage_inflation'), ('sync')) AS a("action")
WHERE m."code" = 'finance'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- 3. Grant finance.read → super_admin + administrador + administracion
--    (roles con visibilidad de gestión, no todo el equipo — datos financieros).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador', 'administracion')
  AND m."code" = 'finance'
  AND p."action" = 'read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- 4. Grant manage_costs/manage_targets/manage_inflation/sync → super_admin + administrador
--    (edición de costos/metas/inflación y disparo manual del sync — administrativo).
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" IN ('super_admin', 'administrador')
  AND m."code" = 'finance'
  AND p."action" IN ('manage_costs', 'manage_targets', 'manage_inflation', 'sync')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
