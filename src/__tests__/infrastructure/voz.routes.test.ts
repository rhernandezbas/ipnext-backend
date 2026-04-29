import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryVozRepository } from '../../infrastructure/adapters/in-memory/InMemoryVozRepository';
import { ListVoipCategories } from '../../application/use-cases/ListVoipCategories';
import { CreateVoipCategory } from '../../application/use-cases/CreateVoipCategory';
import { ListVoipCdrs } from '../../application/use-cases/ListVoipCdrs';
import { ListVoipPlans } from '../../application/use-cases/ListVoipPlans';
import { CreateVoipPlan } from '../../application/use-cases/CreateVoipPlan';
import { createVozRouter } from '../../infrastructure/http/routes/voz.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryVozRepository();
  const listVoipCategories = new ListVoipCategories(repo);
  const createVoipCategory = new CreateVoipCategory(repo);
  const listVoipCdrs = new ListVoipCdrs(repo);
  const listVoipPlans = new ListVoipPlans(repo);
  const createVoipPlan = new CreateVoipPlan(repo);

  app.use('/api/voip', createVozRouter(listVoipCategories, createVoipCategory, listVoipCdrs, listVoipPlans, createVoipPlan));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/voip/categories', () => {
  it('returns 200 with 4 categories', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/voip/categories');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(4);
  });
});

describe('GET /api/voip/cdr', () => {
  it('returns 200 with 10 CDR records', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/voip/cdr');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(10);
  });
});
