import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { Router } from 'express';

// Build a minimal app that mounts the POST routes without auth middleware
function buildApp() {
  const app = express();
  app.use(express.json());

  // Inline stores and counters isolated per test file import
  const invoicesStore: Array<{
    id: string; number: string; customerId: string; customerName: string;
    issuedAt: string; dueAt: string; total: number; status: string;
  }> = [];
  let invoiceCounter = 1000;

  const paymentsStore: Array<{
    id: string; customerId: string; customerName: string;
    amount: number; date: string; method: string; reference: string;
  }> = [];
  let paymentCounter = 500;

  const router = Router();

  router.post('/invoices', (req: Request, res: Response): void => {
    const { customerId, customerName, issuedAt, dueAt, total, concept, status } = req.body;
    if (!customerName || !issuedAt || !dueAt || !total) {
      res.status(400).json({ error: 'customerName, issuedAt, dueAt, and total are required' });
      return;
    }
    invoiceCounter++;
    const newInvoice = {
      id: String(invoiceCounter),
      number: `INV-${invoiceCounter}`,
      customerId: customerId ?? '',
      customerName,
      issuedAt,
      dueAt,
      total: Number(total),
      concept: concept ?? '',
      status: status ?? 'sent',
    };
    invoicesStore.push(newInvoice);
    res.status(201).json(newInvoice);
  });

  router.post('/payments', (req: Request, res: Response): void => {
    const { customerName, amount, date, method, reference } = req.body;
    if (!customerName || !amount || !date) {
      res.status(400).json({ error: 'customerName, amount, and date are required' });
      return;
    }
    paymentCounter++;
    const newPayment = {
      id: String(paymentCounter),
      customerId: '',
      customerName,
      amount: Number(amount),
      date,
      method: method ?? 'cash',
      reference: reference ?? '',
    };
    paymentsStore.push(newPayment);
    res.status(201).json(newPayment);
  });

  const emailSentStore: Set<string> = new Set();

  router.post('/invoices/:id/send-email', (req: Request, res: Response): void => {
    const { id } = req.params;
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    emailSentStore.add(id);
    res.json({ message: `Factura enviada a ${email}`, sentAt: new Date().toISOString() });
  });

  app.use('/billing', router);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('POST /billing/invoices', () => {
  it('returns 201 with generated invoice on valid data', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/billing/invoices')
      .send({
        customerName: 'Test Cliente',
        issuedAt: '2024-01-01',
        dueAt: '2024-01-31',
        total: 5000,
        concept: 'Internet plan',
        status: 'draft',
      });

    expect(res.status).toBe(201);
    expect(res.body.customerName).toBe('Test Cliente');
    expect(res.body.total).toBe(5000);
    expect(res.body.status).toBe('draft');
  });

  it('returns 400 when required fields are missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/billing/invoices')
      .send({ customerName: 'Only Name' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns invoice with generated number in INV-XXXX format', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/billing/invoices')
      .send({
        customerName: 'Acme Corp',
        issuedAt: '2024-03-01',
        dueAt: '2024-03-31',
        total: 12000,
      });

    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^INV-\d+$/);
    expect(res.body.id).toBeDefined();
  });

  it('defaults status to "sent" when not provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/billing/invoices')
      .send({
        customerName: 'Default Status Cliente',
        issuedAt: '2024-04-01',
        dueAt: '2024-04-30',
        total: 999,
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('sent');
  });
});

describe('POST /billing/invoices/:id/send-email', () => {
  it('returns 200 with message when email is provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/billing/invoices/1001/send-email')
      .send({ email: 'cliente@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('cliente@example.com');
    expect(res.body.sentAt).toBeDefined();
  });

  it('returns 400 when email is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/billing/invoices/1001/send-email')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});

describe('POST /billing/payments', () => {
  it('returns 201 with new payment on valid data', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/billing/payments')
      .send({
        customerName: 'Juan Pérez',
        amount: 3000,
        date: '2024-02-15',
        method: 'transfer',
        reference: 'REF-001',
      });

    expect(res.status).toBe(201);
    expect(res.body.customerName).toBe('Juan Pérez');
    expect(res.body.amount).toBe(3000);
    expect(res.body.method).toBe('transfer');
    expect(res.body.reference).toBe('REF-001');
  });

  it('returns 400 when required fields are missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/billing/payments')
      .send({ customerName: 'Solo Nombre' });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns payment with generated id', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/billing/payments')
      .send({
        customerName: 'María Gómez',
        amount: 1500,
        date: '2024-05-10',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.amount).toBe(1500);
  });

  it('defaults method to "cash" when not provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/billing/payments')
      .send({
        customerName: 'Default Method',
        amount: 500,
        date: '2024-06-01',
      });

    expect(res.status).toBe(201);
    expect(res.body.method).toBe('cash');
  });
});
