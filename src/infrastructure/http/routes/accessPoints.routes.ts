import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import type { ListAssignableAccessPoints } from '@application/use-cases/ListAssignableAccessPoints';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * GET /api/access-points?networkSiteId= — catálogo de APs asignables (picker manual, PICK-2/3).
 * Gate: `network.read`. Auth se aplica al MONTAR el router en app.ts (patrón
 * `/api/network-sites`), no dentro de este router.
 */
export function createAccessPointsRouter(
  listAssignable: ListAssignableAccessPoints,
  requirePerm?: RequirePerm,
): Router {
  const router = Router();
  const readPerm: RequestHandler = requirePerm ? requirePerm('network', 'read') : (_req, _res, next) => next();

  router.get('/', readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawNetworkSiteId = req.query['networkSiteId'];
      const networkSiteId = typeof rawNetworkSiteId === 'string' ? rawNetworkSiteId : undefined;
      const data = await listAssignable.execute({ networkSiteId });
      res.json({ data });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
