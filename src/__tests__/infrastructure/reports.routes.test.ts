import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryReportRepository } from '../../infrastructure/adapters/in-memory/InMemoryReportRepository';
import { ListReportDefinitions } from '../../application/use-cases/ListReportDefinitions';
import { GenerateReport } from '../../application/use-cases/GenerateReport';
import { ExportReport } from '../../application/use-cases/ExportReport';
import { createReportsRouter } from '../../infrastructure/http/routes/reports.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryReportRepository();
  const listReportDefinitions = new ListReportDefinitions(repo);
  const generateReport = new GenerateReport(repo);
  const exportReport = new ExportReport(repo);

  app.use('/api/reports', createReportsRouter(listReportDefinitions, generateReport, exportReport));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/reports', () => {
  it('returns 200 with array of 20 definitions', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/reports');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(20);
  });
});

describe('POST /api/reports/generate', () => {
  it('returns 200 with rows for clients_by_status', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/reports/generate')
      .send({ type: 'clients_by_status', filters: {} });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reportType', 'clients_by_status');
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.rows.length).toBeGreaterThan(0);
  });
});

describe('POST /api/reports/export', () => {
  it('returns 200 with CSV content', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/reports/export')
      .send({ type: 'clients_by_status', filters: {} });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(typeof res.text).toBe('string');
    expect(res.text.length).toBeGreaterThan(0);
  });
});
