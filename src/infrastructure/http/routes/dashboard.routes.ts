import { Router, Request, Response } from 'express';
import { GetDashboardStats } from '@application/use-cases/GetDashboardStats';
import { GetDashboardShortcuts } from '@application/use-cases/GetDashboardShortcuts';
import { GetRecentActivity } from '@application/use-cases/GetRecentActivity';

export function createDashboardRouter(
  getDashboardStats: GetDashboardStats,
  getDashboardShortcuts: GetDashboardShortcuts,
  getRecentActivity: GetRecentActivity,
): Router {
  const router = Router();

  router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
    const stats = await getDashboardStats.execute();
    res.json(stats);
  });

  router.get('/shortcuts', async (_req: Request, res: Response): Promise<void> => {
    const shortcuts = await getDashboardShortcuts.execute();
    res.json(shortcuts);
  });

  router.get('/activity', async (_req: Request, res: Response): Promise<void> => {
    const activity = await getRecentActivity.execute();
    res.json(activity);
  });

  return router;
}
