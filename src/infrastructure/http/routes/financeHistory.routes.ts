import { Router, Request, Response } from 'express';
import { ListFinanceHistory } from '@application/use-cases/ListFinanceHistory';

export function createFinanceHistoryRouter(
  listFinanceHistory: ListFinanceHistory,
): Router {
  const router = Router();

  router.get('/history', async (req: Request, res: Response): Promise<void> => {
    const { clientId, from, to } = req.query as Record<string, string>;
    const events = await listFinanceHistory.execute({
      clientId: clientId || undefined,
      from: from || undefined,
      to: to || undefined,
    });
    res.json(events);
  });

  return router;
}
