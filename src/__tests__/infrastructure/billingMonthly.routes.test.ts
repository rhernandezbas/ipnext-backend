import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { GetMonthlyBilling } from '../../application/use-cases/GetMonthlyBilling';
import { InMemoryMonthlyBillingRepository } from '../../infrastructure/adapters/in-memory/InMemoryMonthlyBillingRepository';
import { createBillingMonthlyRouter } from '../../infrastructure/http/routes/billingMonthly.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryMonthlyBillingRepository();
  const getMonthly = new GetMonthlyBilling(repo);

  app.use('/api/billing', createBillingMonthlyRouter(getMonthly));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/billing/monthly', () => {
  it('returns 200 with lastMonth, currentMonth, nextMonth', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/billing/monthly');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('lastMonth');
    expect(res.body).toHaveProperty('currentMonth');
    expect(res.body).toHaveProperty('nextMonth');
  });

  it('each period has invoiced and paid as numbers', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/billing/monthly');

    for (const key of ['lastMonth', 'currentMonth', 'nextMonth'] as const) {
      const period = res.body[key] as { invoiced: unknown; paid: unknown; period: unknown; label: unknown };
      expect(typeof period.invoiced).toBe('number');
      expect(typeof period.paid).toBe('number');
      expect(typeof period.period).toBe('string');
      expect(typeof period.label).toBe('string');
    }
  });
});
