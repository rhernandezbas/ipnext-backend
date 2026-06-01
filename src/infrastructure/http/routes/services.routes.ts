import { Router, Request, Response } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListServices } from '@application/use-cases/ListServices';
import { GetServiceStats } from '@application/use-cases/GetServiceStats';

/**
 * GET /api/services       — global paginated contracts listing for the contracts page.
 * GET /api/services/stats — total + byStatus breakdown (dynamic, no hardcoded statuses).
 *
 * IMPORTANT: /stats MUST be declared before /services so it is matched first
 * (Express matches in declaration order and /services has no /:id catch-all today,
 * but /stats is kept first as a defensive convention).
 */
export function createServicesRouter(
  authProvider: AuthProvider,
  listServices: ListServices,
  getServiceStats: GetServiceStats,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // IMPORTANT: /stats MUST be declared before any /:id catch-all (defensive ordering).
  router.get('/services/stats', auth, async (_req: Request, res: Response): Promise<void> => {
    try {
      const stats = await getServiceStats.execute();
      res.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load service stats';
      res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
    }
  });

  router.get('/services', auth, async (req: Request, res: Response): Promise<void> => {
    const { page, limit, search, status, technology } = req.query as Record<string, string>;
    const result = await listServices.execute({
      page: page ? +page : 1,
      limit: limit ? +limit : 25,
      search,
      status,
      technology,
    });
    res.json(result);
  });

  return router;
}
