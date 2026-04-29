import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryCreditNoteRepository } from '../../infrastructure/adapters/in-memory/InMemoryCreditNoteRepository';
import { ListCreditNotes } from '../../application/use-cases/ListCreditNotes';
import { GetCreditNote } from '../../application/use-cases/GetCreditNote';
import { CreateCreditNote } from '../../application/use-cases/CreateCreditNote';
import { ApplyCreditNote } from '../../application/use-cases/ApplyCreditNote';
import { VoidCreditNote } from '../../application/use-cases/VoidCreditNote';
import { createCreditNotesRouter } from '../../infrastructure/http/routes/creditNotes.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryCreditNoteRepository();
  const listCreditNotes = new ListCreditNotes(repo);
  const getCreditNote = new GetCreditNote(repo);
  const createCreditNote = new CreateCreditNote(repo);
  const applyCreditNote = new ApplyCreditNote(repo);
  const voidCreditNote = new VoidCreditNote(repo);

  app.use('/api/billing', createCreditNotesRouter(listCreditNotes, getCreditNote, createCreditNote, applyCreditNote, voidCreditNote));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/billing/credit-notes', () => {
  it('returns 200 with all credit notes', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/billing/credit-notes');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
  });
});

describe('POST /api/billing/credit-notes', () => {
  it('returns 201 with new credit note in draft status', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/credit-notes')
      .send({
        number: 'NC-2024-007',
        clientId: 'cli-001',
        clientName: 'Test Client',
        amount: 1000,
        taxAmount: 210,
        totalAmount: 1210,
        reason: 'Test reason',
        relatedInvoiceId: null,
        issuedAt: '2024-06-01',
        notes: '',
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
  });
});
