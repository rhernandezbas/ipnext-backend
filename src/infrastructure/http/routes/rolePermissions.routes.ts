/**
 * rolePermissions.routes.ts — sub-resource routes for a role's permission grant set.
 *
 * SDD #3 Phase 4a — role-permissions HTTP routes.
 *
 * Mounted at: /api/admin/rbac/roles
 *
 * Routes:
 *   GET  /:id/permissions  — list current permissionIds for role (rbac.read)
 *   PUT  /:id/permissions  — bulk replace permissionIds for role (rbac.manage_roles)
 *
 * Design: sub-resource = sub-file pattern (consistent with rbacUser.routes.ts).
 * The router receives pre-built middleware factories (requireRbacRead, requireRbacManageRoles)
 * rather than importing requirePermission directly — keeps the router DIP-clean.
 */

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { ListPermissionIdsForRole } from '@application/use-cases/rbac/ListPermissionIdsForRole';
import type { SetRolePermissions } from '@application/use-cases/rbac/SetRolePermissions';
import type { AuditEventRepository } from '@domain/ports/AuditEventRepository';
import { createRequestAuditService } from '../audit/requestAudit';

export function createRolePermissionsRouter(
  listPermIds: ListPermissionIdsForRole,
  setRolePerms: SetRolePermissions,
  requireRbacRead: RequestHandler,
  requireRbacManageRoles: RequestHandler,
  auditRepo?: AuditEventRepository,
): Router {
  const router = Router();

  // GET /:id/permissions — returns the current permissionIds for the role
  // Protected by rbac.read
  router.get(
    '/:id/permissions',
    requireRbacRead,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const permissionIds = await listPermIds.execute(req.params['id'] as string);
        res.json({ permissionIds });
      } catch (err) {
        next(err);
      }
    },
  );

  // PUT /:id/permissions — bulk replace the permission grant set for the role
  // Protected by rbac.manage_roles
  router.put(
    '/:id/permissions',
    requireRbacManageRoles,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const roleId = req.params['id'] as string;
        const { permissionIds } = req.body as { permissionIds: string[] };
        // Capture the prior grant set for a faithful before/after audit.
        const before = auditRepo ? await listPermIds.execute(roleId) : null;
        const updated = await setRolePerms.execute(roleId, permissionIds ?? []);
        if (auditRepo) {
          await createRequestAuditService(auditRepo, req, res).emit({
            action: 'SET_ROLE_PERMISSIONS',
            entityType: 'RbacRole',
            entityId: roleId,
            before: { permissionIds: before ?? [] },
            after: { permissionIds: updated },
          });
        }
        res.json({ permissionIds: updated });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
