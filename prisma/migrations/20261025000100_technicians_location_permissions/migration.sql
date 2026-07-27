-- Migration: 20261023000100_technicians_location_permissions
-- iclass-gps-audit — permisos granulares de la ubicación de técnicos.
--
-- DOS permisos SEPARADOS a propósito (decisión del usuario, 2026-07-26):
--   technicians.location_read  → mapa en vivo. Lo necesita despacho/NOC para OPERAR.
--   technicians.location_audit → auditoría histórica por OS. Sólo supervisión.
--
-- El uso operativo NO debe arrastrar la capacidad de auditar el historial completo
-- de una persona. Por eso son dos acciones y no una.
--
-- Idempotente: todos los INSERT llevan cláusula de conflicto no-op.
-- Sin BEGIN/COMMIT explícito (Prisma envuelve cada migración en su transacción).

-- ─── 1. Módulo technicians ────────────────────────────────────────────────────

INSERT INTO "RbacModule" ("id", "code", "label")
VALUES (gen_random_uuid(), 'technicians', 'Técnicos')
ON CONFLICT ("code") DO NOTHING;

-- ─── 2. Las 2 acciones ────────────────────────────────────────────────────────

INSERT INTO "RbacPermission" ("id", "moduleId", "action")
SELECT gen_random_uuid(), m."id", a."action"
FROM "RbacModule" m
CROSS JOIN (VALUES ('location_read'), ('location_audit')) AS a("action")
WHERE m."code" = 'technicians'
ON CONFLICT ("moduleId", "action") DO NOTHING;

-- ─── 3. super_admin recibe AMBAS ──────────────────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'super_admin'
  AND m."code" = 'technicians'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 4. administrador recibe AMBAS ────────────────────────────────────────────

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'administrador'
  AND m."code" = 'technicians'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ─── 5. noc recibe SÓLO el mapa en vivo ───────────────────────────────────────
-- Despacho necesita ver dónde están las cuadrillas para operar. NO necesita —ni
-- debe tener— la auditoría histórica de una persona.

INSERT INTO "RbacRolePermission" ("roleId", "permissionId", "createdAt")
SELECT r."id", p."id", NOW()
FROM "RbacRole" r
CROSS JOIN "RbacPermission" p
JOIN "RbacModule" m ON m."id" = p."moduleId"
WHERE r."code" = 'noc'
  AND m."code" = 'technicians'
  AND p."action" = 'location_read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
