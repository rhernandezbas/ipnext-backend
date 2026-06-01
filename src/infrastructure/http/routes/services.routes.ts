import { Router, Request, Response } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { ListServices } from '@application/use-cases/ListServices';

/**
 * GET /api/services — global paginated contracts listing for the contracts page.
 * Query params: page, limit, search, status, technology.
 * Response envelope matches the frontend PaginatedResponse:
 *   { data: ContractSummary[], total, page, pageSize, totalPages }.
 */
export function createServicesRouter(
  authProvider: AuthProvider,
  listServices: ListServices,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

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
