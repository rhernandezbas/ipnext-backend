-- Migration: 20261017000000_messaging_bulk_status_permissions
-- bulk-granular-perms — permisos granulares del envío masivo por ESTADO de cliente
-- + para NÚMEROS crudos, y snapshot en Campaign para el re-chequeo en el envío.
--
-- 1. Seed de las 6 nuevas RbacPermission del módulo 'messaging'
--    (bulk_active/bulk_late/bulk_blocked/bulk_inactive/bulk_baja/bulk_numbers).
-- 2. BACKWARD-COMPAT: otorga las 6 a TODO rol que HOY tenga messaging.bulk, para
--    que nadie pierda capacidad de envío (el gate 'bulk' sigue siendo el acceso).
-- 3. Campaign: 2 columnas para el snapshot (recipientStatuses + hasRawRecipients).
--
-- Idempotente: cada INSERT usa una cláusula de conflicto no-op; los ADD COLUMN
-- son IF NOT EXISTS. Sin BEGIN/COMMIT explícito (Prisma envuelve cada migración).

-- ─── 1. Re-seed del módulo messaging (safety-net idempotente para fresh DB) ────

INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'messaging', 'Mensajería')
ON CONFLICT ("code") DO NOTHING;

-- ─── 2. Seed de las 6 permission granulares del envío masivo ───────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", a."action"
FROM "RbacModule" m
CROSS JOIN (
  VALUES ('bulk_active'), ('bulk_late'), ('bulk_blocked'),
         ('bulk_inactive'), ('bulk_baja'), ('bulk_numbers')
) AS a("action")
WHERE m."code" = 'messaging'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 3. BACKWARD-COMPAT: grant de las 6 a TODO rol que ya tenga messaging.bulk ─
-- Por cada rol que HOY tiene el permiso (messaging, 'bulk'), se insertan los grants
-- de las 6 acciones nuevas del mismo módulo. Reusa el join
-- RbacRolePermission → RbacPermission → RbacModule del molde.

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT bulk_grant."roleId", new_p."id", NOW()
FROM "RbacRolePermission" bulk_grant
JOIN "RbacPermission" bulk_p ON bulk_p."id" = bulk_grant."permissionId"
JOIN "RbacModule" bulk_m ON bulk_m."id" = bulk_p."moduleId"
CROSS JOIN "RbacPermission" new_p
JOIN "RbacModule" new_m ON new_m."id" = new_p."moduleId"
WHERE bulk_m."code" = 'messaging'
  AND bulk_p."action" = 'bulk'
  AND new_m."code" = 'messaging'
  AND new_p."action" IN ('bulk_active', 'bulk_late', 'bulk_blocked', 'bulk_inactive', 'bulk_baja', 'bulk_numbers')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 4. Campaign: snapshot de estados presentes + números crudos (re-chequeo send) ─

ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "recipientStatuses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "hasRawRecipients" BOOLEAN NOT NULL DEFAULT false;
