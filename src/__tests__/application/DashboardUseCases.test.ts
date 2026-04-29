import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryDashboardRepository } from '../../infrastructure/adapters/in-memory/InMemoryDashboardRepository';
import { GetDashboardStats } from '../../application/use-cases/GetDashboardStats';
import { GetDashboardShortcuts } from '../../application/use-cases/GetDashboardShortcuts';
import { GetRecentActivity } from '../../application/use-cases/GetRecentActivity';
import { createDashboardRouter } from '../../infrastructure/http/routes/dashboard.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  const repo = new InMemoryDashboardRepository();
  const getStats = new GetDashboardStats(repo);
  const getShortcuts = new GetDashboardShortcuts(repo);
  const getActivity = new GetRecentActivity(repo);
  app.use('/api/dashboard', createDashboardRouter(getStats, getShortcuts, getActivity));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

describe('GetDashboardStats', () => {
  it('returns newClientsThisMonth as a number', async () => {
    const repo = new InMemoryDashboardRepository();
    const uc = new GetDashboardStats(repo);
    const stats = await uc.execute();
    expect(stats.newClientsThisMonth).toEqual(expect.any(Number));
    expect(stats.newClientsThisMonth).toBeGreaterThanOrEqual(0);
  });

  it('stats has cpu, ram and disk usage', async () => {
    const repo = new InMemoryDashboardRepository();
    const uc = new GetDashboardStats(repo);
    const stats = await uc.execute();
    expect(stats.cpuUsage).toBe(23);
    expect(stats.ramUsage).toBe(61);
    expect(stats.diskUsage).toBe(45);
  });
});

describe('GetRecentActivity', () => {
  it('returns 10 items', async () => {
    const repo = new InMemoryDashboardRepository();
    const uc = new GetRecentActivity(repo);
    const activity = await uc.execute();
    expect(activity).toHaveLength(10);
  });
});

describe('GET /api/dashboard/stats', () => {
  it('returns 200 with live stats', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/dashboard/stats');
    expect(res.status).toBe(200);
    expect(res.body.activeClients).toEqual(expect.any(Number));
    expect(res.body.activeClients).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /api/dashboard/activity', () => {
  it('returns 200', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/dashboard/activity');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
