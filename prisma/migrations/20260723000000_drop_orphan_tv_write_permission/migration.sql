-- drop-orphan-tv-write (#101) — Remove the orphan tv:write permission seeded by
-- 20260630000000_gigared_tv. After the granular permissions migration
-- (20260705000000_tv_granular_permissions) replaced tv:write with
-- tv:link/register/packs/ott/cancel, no route uses tv:write as a guard.
-- The permission row remains visible in the PermissionMatrix as an inert checkbox,
-- misleading operators into thinking it has an effect.
--
-- Strategy:
--   RbacRolePermission.permissionId has onDelete: Cascade (schema.prisma line ~2182),
--   so deleting the RbacPermission row automatically removes all role-permission
--   assignments for that permission. No manual DELETE on RbacRolePermission needed.
--
-- Idempotent: DELETE ... WHERE EXISTS is a no-op when the row is already gone.
-- No BEGIN/COMMIT — Prisma wraps every migration in its own transaction.

DELETE FROM "RbacPermission"
WHERE "action" = 'write'
  AND "moduleId" = (
    SELECT "id" FROM "RbacModule" WHERE "code" = 'tv'
  );
