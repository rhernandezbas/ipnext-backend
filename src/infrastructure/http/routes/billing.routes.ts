import { Router, Request, Response } from 'express';
import { GetBillingSummary } from '@application/use-cases/GetBillingSummary';
import { ListInvoices } from '@application/use-cases/ListInvoices';
import { ListPayments } from '@application/use-cases/ListPayments';
import { ListTransactions } from '@application/use-cases/ListTransactions';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { JwtAuthAdapter } from '../../adapters/jwt/JwtAuthAdapter';

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

export function createBillingRouter(
  getSummary: GetBillingSummary,
  listInvoices: ListInvoices,
  listPayments: ListPayments,
  listTransactions: ListTransactions,
  authProvider: JwtAuthAdapter,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  router.get('/summary', auth, async (_req: Request, res: Response): Promise<void> => {
    const summary = await getSummary.execute();
    res.json(summary);
  });

  router.get('/invoices', auth, async (req: Request, res: Response): Promise<void> => {
    const { page, limit, status, dateFrom, dateTo, search } = req.query as Record<string, string>;
    const result = await listInvoices.execute({ page: page ? +page : 1, limit: limit ? +limit : 25, status, dateFrom, dateTo, search });
    res.json(result);
  });

  router.get('/payments', auth, async (req: Request, res: Response): Promise<void> => {
    const { page, limit, search } = req.query as Record<string, string>;
    const result = await listPayments.execute({ page: page ? +page : 1, limit: limit ? +limit : 25, search });
    res.json(result);
  });

  router.get('/transactions', auth, async (req: Request, res: Response): Promise<void> => {
    const { page, limit, dateFrom, dateTo } = req.query as Record<string, string>;
    const result = await listTransactions.execute({ page: page ? +page : 1, limit: limit ? +limit : 25, dateFrom, dateTo });
    res.json(result);
  });

  router.post('/invoices', auth, (req: Request, res: Response): void => {
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

  // Track which invoices have been "sent" by email
  const emailSentStore: Set<string> = new Set();

  router.post('/invoices/:id/send-email', auth, (req: Request, res: Response): void => {
    const { id } = req.params;
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    // Simulate email send (log and store)
    emailSentStore.add(id);
    console.log(`[EMAIL] Invoice ${id} sent to ${email}`);
    res.json({ message: `Factura enviada a ${email}`, sentAt: new Date().toISOString() });
  });

  router.post('/payments', auth, (req: Request, res: Response): void => {
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

  return router;
}
