import { Router, Request, Response, NextFunction } from 'express';
import { GetMonthlyBilling } from '@application/use-cases/GetMonthlyBilling';

export function createBillingMonthlyRouter(getMonthly: GetMonthlyBilling): Router {
  const router = Router();

  router.get('/monthly', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const data = await getMonthly.execute();
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
