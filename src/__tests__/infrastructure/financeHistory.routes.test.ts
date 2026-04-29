import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryFinanceHistoryRepository } from '../../infrastructure/adapters/in-memory/InMemoryFinanceHistoryRepository';
import { ListFinanceHistory } from '../../application/use-cases/ListFinanceHistory';
import { createFinanceHistoryRouter } from '../../infrastructure/http/routes/financeHistory.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryFinanceHistoryRepository();
  const listFinanceHistory = new ListFinanceHistory(repo);

  app.use('/api/billing', createFinanceHistoryRouter(listFinanceHistory));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/billing/history', () => {
  it('returns 200 with all 15 events', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/billing/history');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(15);
  });

  it('returns filtered events by clientId', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/billing/history?clientId=cli-001');

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    res.body.forEach((e: { clientId: string }) => expect(e.clientId).toBe('cli-001'));
  });
});
