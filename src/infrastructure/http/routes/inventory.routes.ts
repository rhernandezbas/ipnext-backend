import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';

/**
 * Inventory depot read surface (EPIC #38, Wave 3). Mounted at `/api/inventory`.
 *
 * `GET /depot` → read-only DEPOSITO stock (available assets + materials),
 * guarded by `inventory.read` (same pattern as the W2 client-equipment route).
 * The use case never mutates and never returns raw entities — DTOs only.
 */
export function createInventoryRouter(
  getDepotStock: GetDepotStock,
  auth: RequestHandler,
  requireRead: RequestHandler,
): Router {
  const router = Router();

  router.get('/depot', auth, requireRead, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getDepotStock.execute());
    } catch (e) {
      next(e);
    }
  });

  return router;
}
