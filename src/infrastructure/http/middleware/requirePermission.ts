import { Request, Response, NextFunction } from 'express';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { PermissionAction, RbacModuleCode } from '@domain/entities/rbac';

/**
 * requirePermission — factory that returns an Express middleware guarding a
 * route by (module, action).
 *
 * Resolution path:
 *   1. Resolve req.user.id — 401 if absent.
 *   2. listRolesForUser → if any role.code === 'super_admin' → next() (short-circuit).
 *   3. listPermissionsForUser → if any perm matches (module, action) → next().
 *   4. Otherwise → 403 PERMISSION_DENIED.
 *
 * Fail-closed: unknown module code or missing permission always yields 403,
 * never 500 or 404.
 *
 * No in-process cache (v1). See design.md — caching deferred to SDD #5.
 */
export function requirePermission(
  userRepo: RbacUserRepository,
  module: RbacModuleCode,
  action: PermissionAction,
) {
  return async function guard(req: Request, res: Response, next: NextFunction): Promise<void> {
    const userId = (req as any).user?.id as string | undefined;

    if (!userId) {
      res.status(401).json({ error: 'UNAUTHORIZED', code: 'NO_USER_CONTEXT' });
      return;
    }

    // super_admin short-circuit — must happen BEFORE permission lookup
    const roles = await userRepo.listRolesForUser(userId);
    if (roles.some((r) => r.code === 'super_admin')) {
      next();
      return;
    }

    // Permission check — fail-closed: unknown module code → no match → 403
    const perms = await userRepo.listPermissionsForUser(userId);
    const granted = perms.some((p) => p.moduleCode === module && p.action === action);

    if (!granted) {
      res.status(403).json({
        error: 'FORBIDDEN',
        code: 'PERMISSION_DENIED',
        module,
        action,
      });
      return;
    }

    next();
  };
}
