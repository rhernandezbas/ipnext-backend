import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryProformaRepository } from '../../infrastructure/adapters/in-memory/InMemoryProformaRepository';
import { ListProformas } from '../../application/use-cases/ListProformas';
import { CreateProforma } from '../../application/use-cases/CreateProforma';
import { ConvertToInvoice } from '../../application/use-cases/ConvertToInvoice';
import { CancelProforma } from '../../application/use-cases/CancelProforma';
import { createProformasRouter } from '../../infrastructure/http/routes/proformas.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryProformaRepository();
  const listProformas = new ListProformas(repo);
  const createProforma = new CreateProforma(repo);
  const convertToInvoice = new ConvertToInvoice(repo);
  const cancelProforma = new CancelProforma(repo);

  app.use('/api/billing', createProformasRouter(listProformas, createProforma, convertToInvoice, cancelProforma));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/billing/proformas', () => {
  it('returns 200 with all proformas', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/billing/proformas');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
  });
});

describe('POST /api/billing/proformas', () => {
  it('returns 201 with new proforma in draft status', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/proformas')
      .send({
        number: 'PRO-2024-006',
        clientId: 'cli-001',
        clientName: 'Test Client',
        items: [{ description: 'Plan 100 Mbps', quantity: 1, unitPrice: 6500, total: 6500 }],
        subtotal: 6500,
        taxAmount: 1365,
        total: 7865,
        issuedAt: '2024-06-01',
        validUntil: '2024-06-16',
        notes: '',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
  });
});
