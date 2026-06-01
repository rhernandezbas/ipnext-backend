import { Router, Request, Response } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListContracts } from '@application/use-cases/ListContracts';
import { GetContractStats } from '@application/use-cases/GetContractStats';

/**
 * GET /api/contracts       — global paginated contracts listing for the contracts page.
 * GET /api/contracts/stats — total + byStatus breakdown (dynamic, no hardcoded statuses).
 *
 * IMPORTANT: /stats MUST be declared before /contracts so it is matched first
 * (Express matches in declaration order and /contracts has no /:id catch-all today,
 * but /stats is kept first as a defensive convention).
 */
export function createContractsRouter(
  authProvider: AuthProvider,
  listContracts: ListContracts,
  getContractStats: GetContractStats,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // IMPORTANT: /stats MUST be declared before any /:id catch-all (defensive ordering).
  router.get('/contracts/stats', auth, async (_req: Request, res: Response): Promise<void> => {
    try {
      const stats = await getContractStats.execute();
      res.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load contract stats';
      res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
    }
  });

  router.get('/contracts', auth, async (req: Request, res: Response): Promise<void> => {
    const { page, limit, search, status, technology } = req.query as Record<string, string>;
    const result = await listContracts.execute({
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
