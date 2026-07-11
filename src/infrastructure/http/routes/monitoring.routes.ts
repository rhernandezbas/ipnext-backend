import { Router, Request, Response, NextFunction } from 'express';
import { GetMonitoringStats } from '@application/use-cases/GetMonitoringStats';
import { ListMonitoringDevices } from '@application/use-cases/ListMonitoringDevices';
import { ListMonitoringAlerts } from '@application/use-cases/ListMonitoringAlerts';
import { AcknowledgeAlert } from '@application/use-cases/AcknowledgeAlert';

export function createMonitoringRouter(
  getStats: GetMonitoringStats,
  listDevices: ListMonitoringDevices,
  listAlerts: ListMonitoringAlerts,
  acknowledgeAlert: AcknowledgeAlert,
): Router {
  const router = Router();

  router.get('/stats', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const stats = await getStats.execute();
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  router.get('/devices', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const devices = await listDevices.execute();
      res.json(devices);
    } catch (err) {
      next(err);
    }
  });

  router.get('/alerts', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const alerts = await listAlerts.execute();
      res.json(alerts);
    } catch (err) {
      next(err);
    }
  });

  router.put('/alerts/:id/acknowledge', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const alert = await acknowledgeAlert.execute(req.params['id'] as string);
      if (!alert) {
        res.status(404).json({ error: 'Alert not found', code: 'ALERT_NOT_FOUND' });
        return;
      }
      res.json(alert);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
