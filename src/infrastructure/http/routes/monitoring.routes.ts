import { Router, Request, Response } from 'express';
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

  router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
    const stats = await getStats.execute();
    res.json(stats);
  });

  router.get('/devices', async (_req: Request, res: Response): Promise<void> => {
    const devices = await listDevices.execute();
    res.json(devices);
  });

  router.get('/alerts', async (_req: Request, res: Response): Promise<void> => {
    const alerts = await listAlerts.execute();
    res.json(alerts);
  });

  router.put('/alerts/:id/acknowledge', async (req: Request, res: Response): Promise<void> => {
    const alert = await acknowledgeAlert.execute(req.params['id'] as string);
    if (!alert) {
      res.status(404).json({ error: 'Alert not found', code: 'ALERT_NOT_FOUND' });
      return;
    }
    res.json(alert);
  });

  return router;
}
