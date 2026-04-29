import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryMonitoringRepository } from '../../infrastructure/adapters/in-memory/InMemoryMonitoringRepository';
import { GetMonitoringStats } from '../../application/use-cases/GetMonitoringStats';
import { ListMonitoringDevices } from '../../application/use-cases/ListMonitoringDevices';
import { ListMonitoringAlerts } from '../../application/use-cases/ListMonitoringAlerts';
import { AcknowledgeAlert } from '../../application/use-cases/AcknowledgeAlert';
import { createMonitoringRouter } from '../../infrastructure/http/routes/monitoring.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  const repo = new InMemoryMonitoringRepository();
  const getStats = new GetMonitoringStats(repo);
  const listDevices = new ListMonitoringDevices(repo);
  const listAlerts = new ListMonitoringAlerts(repo);
  const acknowledgeAlert = new AcknowledgeAlert(repo);
  app.use('/api/monitoring', createMonitoringRouter(getStats, listDevices, listAlerts, acknowledgeAlert));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

describe('GetMonitoringStats', () => {
  it('returns correct totals: 15 total, 10 online, 3 offline, 2 warning', async () => {
    const repo = new InMemoryMonitoringRepository();
    const uc = new GetMonitoringStats(repo);
    const stats = await uc.execute();
    expect(stats.totalDevices).toBe(15);
    expect(stats.onlineDevices).toBe(10);
    expect(stats.offlineDevices).toBe(3);
    expect(stats.warningDevices).toBe(2);
  });
});

describe('ListMonitoringDevices', () => {
  it('returns 15 devices', async () => {
    const repo = new InMemoryMonitoringRepository();
    const uc = new ListMonitoringDevices(repo);
    const devices = await uc.execute();
    expect(devices).toHaveLength(15);
  });
});

describe('ListMonitoringAlerts', () => {
  it('returns 8 alerts', async () => {
    const repo = new InMemoryMonitoringRepository();
    const uc = new ListMonitoringAlerts(repo);
    const alerts = await uc.execute();
    expect(alerts).toHaveLength(8);
  });
});

describe('AcknowledgeAlert', () => {
  it('marks alert as acknowledged', async () => {
    const repo = new InMemoryMonitoringRepository();
    const uc = new AcknowledgeAlert(repo);
    const result = await uc.execute('alert-1');
    expect(result).not.toBeNull();
    expect(result?.acknowledged).toBe(true);
  });
});

describe('GET /api/monitoring/stats', () => {
  it('returns 200', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/monitoring/stats');
    expect(res.status).toBe(200);
    expect(res.body.totalDevices).toBe(15);
  });
});
