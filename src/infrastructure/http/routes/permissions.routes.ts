/**
 * permissions.routes.ts — GET /api/admin/rbac/permissions
 *
 * SDD #3 Phase 4a — permission catalog endpoint.
 * Returns all permissions so the FE can render the matrix column headers,
 * grouped by moduleCode.
 *
 * Protected by requirePerm('rbac', 'read'). super_admin short-circuits.
 */

import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { ListAllPermissionsWithModule } from '@application/use-cases/rbac/ListAllPermissionsWithModule';

export function createPermissionsRouter(
  listAllPermissions: ListAllPermissionsWithModule,
): Router {
  const router = Router();

  // GET / — returns full permission catalog
  router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const permissions = await listAllPermissions.execute();
      res.json({ permissions });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
