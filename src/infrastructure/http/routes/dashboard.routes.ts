import { Router, Request, Response, NextFunction } from 'express';
import { GetDashboardStats } from '@application/use-cases/GetDashboardStats';
import { GetDashboardShortcuts } from '@application/use-cases/GetDashboardShortcuts';
import { GetRecentActivity } from '@application/use-cases/GetRecentActivity';

export function createDashboardRouter(
  getDashboardStats: GetDashboardStats,
  getDashboardShortcuts: GetDashboardShortcuts,
  getRecentActivity: GetRecentActivity,
): Router {
  const router = Router();

  router.get('/stats', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const stats = await getDashboardStats.execute();
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  router.get('/shortcuts', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const shortcuts = await getDashboardShortcuts.execute();
      res.json(shortcuts);
    } catch (err) {
      next(err);
    }
  });

  router.get('/activity', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const activity = await getRecentActivity.execute();
      res.json(activity);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
