import { Router, Request, Response } from 'express';
import { GlobalSearch } from '@application/use-cases/GlobalSearch';

export function createSearchRouter(globalSearch: GlobalSearch): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response): void => {
    const query = (req.query['q'] as string) ?? '';
    const result = globalSearch.execute(query);
    res.json(result);
  });

  return router;
}
