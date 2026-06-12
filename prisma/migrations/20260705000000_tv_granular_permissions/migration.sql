-- tv-granular-permissions (#50) — granular Gigared TV permissions (data-only, aditiva, idempotente).
-- Prisma wraps each migration in its own transaction; no BEGIN/COMMIT here.
--
-- Reemplaza el guard genérico tv:write por acciones de negocio: link/register/packs/ott/cancel.
-- Back-compat: 'administrador' tenía tv:write (cubría toda la operación) → recibe las 5 nuevas para
-- conservar su capacidad. super_admin opera por sentinel '*' (no necesita rows); se le otorgan igual
-- por consistencia con la migración 20260630000000_gigared_tv. action es VARCHAR(64) (enum dropeado).

-- ============================================================
-- 1. Seed tv:link / tv:register / tv:packs / tv:ott / tv:cancel permissions
-- ============================================================
INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", a."action"
FROM "RbacModule" m
CROSS JOIN (VALUES ('link'), ('register'), ('packs'), ('ott'), ('cancel')) AS a("action")
WHERE m."code" = 'tv'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ============================================================
-- 2. Grant the 5 granular tv permissions to super_admin AND administrador
--    (administrador back-compat: previously held tv:write covering all of these).
-- ============================================================
INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE m."code" = 'tv'
  AND r."code" IN ('super_admin', 'administrador')
  AND p."action" IN ('link', 'register', 'packs', 'ott', 'cancel')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
