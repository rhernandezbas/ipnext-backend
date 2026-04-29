import { Router, Request, Response } from 'express';
import { GetMonthlyBilling } from '@application/use-cases/GetMonthlyBilling';

export function createBillingMonthlyRouter(getMonthly: GetMonthlyBilling): Router {
  const router = Router();

  router.get('/monthly', async (_req: Request, res: Response): Promise<void> => {
    const data = await getMonthly.execute();
    res.json(data);
  });

  return router;
}
