import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { GlobalSearch } from '../../application/use-cases/GlobalSearch';
import { createSearchRouter } from '../../infrastructure/http/routes/search.routes';

function buildApp() {
  const app = express();
  app.use(express.json());
  const globalSearch = new GlobalSearch();
  app.use('/api/search', createSearchRouter(globalSearch));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

describe('GlobalSearch', () => {
  it('returns results including admins when querying "admin"', () => {
    const uc = new GlobalSearch();
    const result = uc.execute('admin');
    expect(result.total).toBeGreaterThan(0);
    const adminResults = result.results.filter(r => r.type === 'admin');
    expect(adminResults.length).toBeGreaterThan(0);
  });

  it('returns empty result for short query (1 char)', () => {
    const uc = new GlobalSearch();
    const result = uc.execute('a');
    expect(result.total).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('returns results from multiple entity types', () => {
    const uc = new GlobalSearch();
    const result = uc.execute('carlos');
    const types = new Set(result.results.map(r => r.type));
    expect(types.size).toBeGreaterThan(1);
  });

  it('GET /api/search?q=carlos returns 200 with results', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/search?q=carlos');
    expect(res.status).toBe(200);
    expect(res.body.results).toBeDefined();
    expect(res.body.total).toBeGreaterThan(0);
  });
});
