import { Router, Request, Response, NextFunction } from 'express';
import { ListVoipCategories } from '@application/use-cases/ListVoipCategories';
import { CreateVoipCategory } from '@application/use-cases/CreateVoipCategory';
import { ListVoipCdrs } from '@application/use-cases/ListVoipCdrs';
import { ListVoipPlans } from '@application/use-cases/ListVoipPlans';
import { CreateVoipPlan } from '@application/use-cases/CreateVoipPlan';
import { VoipCategory, VoipPlan } from '@domain/entities/voz';

export function createVozRouter(
  listVoipCategories: ListVoipCategories,
  createVoipCategory: CreateVoipCategory,
  listVoipCdrs: ListVoipCdrs,
  listVoipPlans: ListVoipPlans,
  createVoipPlan: CreateVoipPlan,
): Router {
  const router = Router();

  router.get('/categories', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const categories = await listVoipCategories.execute();
      res.json(categories);
    } catch (err) {
      next(err);
    }
  });

  router.post('/categories', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const category = await createVoipCategory.execute(req.body as Omit<VoipCategory, 'id'>);
      res.status(201).json(category);
    } catch (err) {
      next(err);
    }
  });

  router.get('/cdr', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const cdrs = await listVoipCdrs.execute();
      res.json(cdrs);
    } catch (err) {
      next(err);
    }
  });

  router.get('/plans', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const plans = await listVoipPlans.execute();
      res.json(plans);
    } catch (err) {
      next(err);
    }
  });

  router.post('/plans', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const plan = await createVoipPlan.execute(req.body as Omit<VoipPlan, 'id'>);
      res.status(201).json(plan);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
