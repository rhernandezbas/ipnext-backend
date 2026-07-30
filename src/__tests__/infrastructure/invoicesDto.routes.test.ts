/**
 * Integration test: GET /api/clients/:id/invoices returns the stable InvoiceDto
 * contract (NOT the raw domain entity). The FE consumes this shape verbatim.
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createClientsRouter } from '@infrastructure/http/routes/clients.routes';
import { ListClients } from '@application/use-cases/ListClients';
import { GetClientDetail } from '@application/use-cases/GetClientDetail';
import { GetClientContracts } from '@application/use-cases/GetClientContracts';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { CreateCustomer } from '@application/use-cases/CreateCustomer';
import { GetClientStats } from '@application/use-cases/GetClientStats';
import { DeleteCustomer } from '@application/use-cases/DeleteCustomer';
import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { Invoice } from '@domain/entities/billing';
import { JwtAuthAdapter } from '@infrastructure/adapters/jwt/JwtAuthAdapter';

const authStub = {
  getSession: jest.fn().mockResolvedValue({ id: 'admin-1', email: 't@t.com', role: 'admin', username: 'admin' }),
} as unknown as JwtAuthAdapter;

const GR_INVOICE: Invoice = {
  id: 'inv-1',
  number: '000074035',
  customerId: 'client-1',
  customerName: 'Deudor Test',
  issueDate: '2026-06-26T03:00:00.000Z',
  dueDate: '2026-07-07T03:00:00.000Z',
  amount: 35121.37,
  status: 'pendiente',
  lineItems: [],
  grInvoiceId: 'FB-00010-000074035',
  balance: 35121.37,
  grType: 'FB',
  currency: 'PES',
  pdfUrl: 'https://pdf',
  couponPdfUrl: 'https://cupon',
  paymentUrl: 'https://mp',
};

function makeRepo(invoices: Invoice[]): CustomerRepository {
  return {
    findById: jest.fn(),
    list: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn(),
    listContracts: jest.fn(),
    listInvoices: jest.fn().mockResolvedValue(invoices),
    listLogs: jest.fn(),
    updateLocation: jest.fn(),
    listActiveContacts: jest.fn().mockResolvedValue([]),
    getPortalBalanceSummary: jest.fn().mockResolvedValue(null),
  };
}

function buildApp(repo: CustomerRepository) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const stub = { execute: jest.fn() } as never;
  app.use('/api/clients', createClientsRouter(
    new ListClients(repo),
    new GetClientDetail(repo),
    new GetClientContracts(repo),
    new GetClientInvoices(repo),
    new GetClientLogs(repo),
    authStub,
    stub, // createCustomer
    { execute: jest.fn().mockResolvedValue({ total: 0, active: 0, inactive: 0, blocked: 0, late: 0 }) } as never,
    stub, // deleteCustomer
  ));
  return app;
}

describe('GET /api/clients/:id/invoices — InvoiceDto contract', () => {
  it('returns 200 with an array of InvoiceDto (mapped, not the raw entity)', async () => {
    const app = buildApp(makeRepo([GR_INVOICE]));

    const res = await request(app)
      .get('/api/clients/client-1/invoices')
      .set('Cookie', 'auth_token=fake');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);

    const dto = res.body[0];
    // Exact DTO contract — keys the FE consumes verbatim.
    expect(Object.keys(dto).sort()).toEqual(
      ['amount', 'balance', 'couponPdfUrl', 'currency', 'dueDate', 'grType', 'id', 'issueDate', 'number', 'paymentUrl', 'pdfUrl', 'status'].sort(),
    );
    expect(dto.id).toBe('inv-1');
    expect(dto.number).toBe('000074035');
    expect(dto.grType).toBe('FB');
    expect(dto.amount).toBe(35121.37);
    expect(dto.balance).toBe(35121.37);
    expect(dto.currency).toBe('PES');
    expect(dto.status).toBe('pendiente');
    expect(dto.issueDate).toBe('2026-06-26T03:00:00.000Z');
    expect(dto.dueDate).toBe('2026-07-07T03:00:00.000Z');
    expect(dto.pdfUrl).toBe('https://pdf');
    expect(dto.couponPdfUrl).toBe('https://cupon');
    expect(dto.paymentUrl).toBe('https://mp');
    // The raw domain-only fields must NOT leak.
    expect(dto).not.toHaveProperty('lineItems');
    expect(dto).not.toHaveProperty('customerId');
    expect(dto).not.toHaveProperty('grInvoiceId');
  });

  it('returns an empty array (no crash) when the client has no invoices', async () => {
    const app = buildApp(makeRepo([]));
    const res = await request(app)
      .get('/api/clients/client-1/invoices')
      .set('Cookie', 'auth_token=fake');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
