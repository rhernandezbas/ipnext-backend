import { Router, Request, Response } from 'express';
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

  router.get('/categories', async (_req: Request, res: Response): Promise<void> => {
    const categories = await listVoipCategories.execute();
    res.json(categories);
  });

  router.post('/categories', async (req: Request, res: Response): Promise<void> => {
    const category = await createVoipCategory.execute(req.body as Omit<VoipCategory, 'id'>);
    res.status(201).json(category);
  });

  router.get('/cdr', async (_req: Request, res: Response): Promise<void> => {
    const cdrs = await listVoipCdrs.execute();
    res.json(cdrs);
  });

  router.get('/plans', async (_req: Request, res: Response): Promise<void> => {
    const plans = await listVoipPlans.execute();
    res.json(plans);
  });

  router.post('/plans', async (req: Request, res: Response): Promise<void> => {
    const plan = await createVoipPlan.execute(req.body as Omit<VoipPlan, 'id'>);
    res.status(201).json(plan);
  });

  return router;
}
