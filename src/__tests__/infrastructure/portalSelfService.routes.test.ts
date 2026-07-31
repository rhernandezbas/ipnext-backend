/**
 * customer-portal-api (Fases 4/5/6, tasks 4.5/5.1-5.3/6.2) — route-level coverage
 * of every scenario in portal-self-service/spec.md + portal-account-deletion/spec.md,
 * wired end to end with in-memory adapters (no Prisma, mismo criterio que
 * portal.routes.test.ts de la Fase 2).
 *
 * Fixtures SIEMPRE con >=2 clientes (A y B) para las pruebas anti-IDOR — nunca
 * un solo elemento (lección "fixtures degenerados").
 */
import express, { Request, Response } from 'express';
import request from 'supertest';

import { createPortalRouter } from '@infrastructure/http/routes/portal.routes';
import { createPortalAuthMiddleware } from '@infrastructure/http/middleware/portalAuthMiddleware';
import { createPortalKillSwitchMiddleware } from '@infrastructure/http/middleware/portalKillSwitchMiddleware';
import { createPortalGeneralRateLimiter, createPortalTicketCreateRateLimiter } from '@infrastructure/http/middleware/rateLimiters';

import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { RefreshPortalSession } from '@application/use-cases/portal/RefreshPortalSession';
import { LogoutPortal } from '@application/use-cases/portal/LogoutPortal';
import { ChangePortalPassword } from '@application/use-cases/portal/ChangePortalPassword';
import { GetPortalMe } from '@application/use-cases/portal/GetPortalMe';
import { ListPortalInvoices } from '@application/use-cases/portal/ListPortalInvoices';
import { ListPortalPlans } from '@application/use-cases/portal/ListPortalPlans';
import { ListPortalTasks } from '@application/use-cases/portal/ListPortalTasks';
import { ListPortalTickets } from '@application/use-cases/portal/ListPortalTickets';
import { GetPortalTicket } from '@application/use-cases/portal/GetPortalTicket';
import { CreatePortalTicket } from '@application/use-cases/portal/CreatePortalTicket';
import { DeleteMyPortalAccount } from '@application/use-cases/portal/DeleteMyPortalAccount';

import { InMemoryPortalAccountRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalAccountRepository';
import { InMemoryPortalSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryPortalSessionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { InMemorySettingsRepository } from '@infrastructure/adapters/in-memory/InMemorySettingsRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import { JwtPortalTokenService } from '@infrastructure/adapters/jwt/JwtPortalTokenService';

import type { CustomerRepository, PortalBalanceSummary } from '@domain/ports/CustomerRepository';
import type { Customer, Contract } from '@domain/entities/customer';
import type { Invoice } from '@domain/entities/billing';
import { ClientNotFoundError } from '@domain/errors';
import { normalizeGrCurrency } from '@domain/services/normalizeGrCurrency';

const TEST_SECRET = 'test-jwt-secret-32chars-minimum!';
const STAGE_NUEVO = '10000000-0000-4000-a000-000000000001';

function makeContract(overrides: Partial<Contract> & { id: string }): Contract {
  return {
    code: null,
    type: 'internet',
    plan: '50 Mb Simetrico',
    ip: '10.0.0.1',
    status: 'active',
    startDate: '2025-01-01T00:00:00.000Z',
    endDate: '',
    address: null,
    lat: null,
    lng: null,
    technology: null,
    name: null,
    vendedor: null,
    services: [],
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<Customer> & { id: string }): Customer {
  return {
    name: 'Cliente',
    email: 'c@example.com',
    phone: '1150001111',
    status: 'active',
    address: 'Calle 1',
    city: 'CABA',
    country: 'AR',
    login: overrides.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    balanceDue: null,
    balanceCurrency: null,
    lastBalanceAt: null,
    ...overrides,
  };
}

/** Fake CustomerRepository INLINE MINIMO — convención del repo, ver GetPortalMe.test.ts. */
class FakeCustomerRepository implements Partial<CustomerRepository> {
  private customers = new Map<string, Customer>();
  private contracts = new Map<string, Contract[]>();
  private invoices = new Map<string, Invoice[]>();

  seedCustomer(c: Customer): void { this.customers.set(c.id, c); }
  seedContracts(clientId: string, contracts: Contract[]): void { this.contracts.set(clientId, contracts); }
  seedInvoices(clientId: string, invoices: Invoice[]): void { this.invoices.set(clientId, invoices); }

  async findById(id: string): Promise<Customer> {
    const c = this.customers.get(id);
    if (!c) throw new ClientNotFoundError(id);
    return c;
  }
  async listContracts(clientId: string): Promise<Contract[]> { return this.contracts.get(clientId) ?? []; }
  async listInvoices(clientId: string): Promise<Invoice[]> { return this.invoices.get(clientId) ?? []; }

  /**
   * fix/portal-balance-from-invoices — mismo contrato que
   * `PrismaCustomerRepository.getPortalBalanceSummary` (ver su doc), calculado
   * EN MEMORIA sobre las facturas seedeadas. Este fake NO tiene `Invoice.createdAt`
   * (la entidad de dominio no lo expone) — usa `issueDate` como proxy de
   * frescura, suficiente para probar el WIRING de la ruta; la semántica exacta
   * de `lastUpdatedAt` está unit-testeada en `GetPortalMe.test.ts` y
   * `PrismaCustomerRepository.mappers.test.ts`.
   *
   * fix wave (multi-moneda) — agrupa por moneda ISO normalizada
   * (`normalizeGrCurrency`), mismo criterio que el mapper real: NUNCA suma
   * monedas distintas en un solo número.
   */
  async getPortalBalanceSummary(clientId: string): Promise<PortalBalanceSummary | null> {
    const list = this.invoices.get(clientId) ?? [];
    if (list.length === 0) return null;
    const unpaid = list.filter((i) => i.status !== 'pagada');
    const mostRecent = list.reduce((a, b) => (b.issueDate > a.issueDate ? b : a));

    if (unpaid.length === 0) {
      return {
        balances: [{ currency: normalizeGrCurrency(mostRecent.currency) ?? 'DESCONOCIDA', amount: 0 }],
        lastUpdatedAt: mostRecent.issueDate,
      };
    }

    const merged = new Map<string, number>();
    let unknownAmount: number | null = null;
    for (const inv of unpaid) {
      const iso = normalizeGrCurrency(inv.currency);
      const amount = inv.balance ?? 0;
      if (iso === null) {
        unknownAmount = (unknownAmount ?? 0) + amount;
        continue;
      }
      merged.set(iso, (merged.get(iso) ?? 0) + amount);
    }
    if (unknownAmount !== null) {
      const label = merged.size === 0 ? 'ARS' : 'DESCONOCIDA';
      merged.set(label, (merged.get(label) ?? 0) + unknownAmount);
    }

    const balances = Array.from(merged.entries())
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => b.amount - a.amount);

    const lastUpdatedAt = unpaid.reduce<string | null>(
      (latest, i) => (!latest || i.issueDate > latest ? i.issueDate : latest),
      null,
    ) as string;

    return { balances, lastUpdatedAt };
  }
}

function buildStack() {
  const accounts = new InMemoryPortalAccountRepository();
  const sessions = new InMemoryPortalSessionRepository();
  const hasher = new InMemoryPasswordHasher();
  const settingsRepo = new InMemorySettingsRepository();
  const tokenService = new JwtPortalTokenService(TEST_SECRET);
  const customers = new FakeCustomerRepository();
  const scheduling = new InMemorySchedulingRepository();
  const ticketRepo = new InMemoryTicketRepository();
  const ticketCommentRepo = new InMemoryTicketCommentRepository();
  const areaRepo = new InMemoryTicketAreaCatalogRepository();
  ticketRepo.seedAreas(areaRepo);

  const portalLogin = new PortalLogin(accounts, sessions, hasher, tokenService);
  const refreshPortalSession = new RefreshPortalSession(accounts, sessions, tokenService);
  const logoutPortal = new LogoutPortal(sessions);
  const changePortalPassword = new ChangePortalPassword(accounts, hasher, sessions);
  const getPortalMe = new GetPortalMe(customers as unknown as CustomerRepository);
  const listPortalInvoices = new ListPortalInvoices(customers as unknown as CustomerRepository);
  const listPortalPlans = new ListPortalPlans(customers as unknown as CustomerRepository);
  const listPortalTasks = new ListPortalTasks(scheduling);
  const listPortalTickets = new ListPortalTickets(ticketRepo, ticketCommentRepo);
  // v2.A (portal-ticket-contract) — mismo `customers` fake que el resto del
  // stack, reusado (no una instancia paralela) para la validación de contrato.
  const getPortalTicket = new GetPortalTicket(ticketRepo, customers as unknown as CustomerRepository, ticketCommentRepo);
  const createPortalTicket = new CreatePortalTicket(ticketRepo, areaRepo, customers as unknown as CustomerRepository);
  const deleteMyPortalAccount = new DeleteMyPortalAccount(accounts, sessions, hasher);

  const portalAuthMiddleware = createPortalAuthMiddleware(tokenService, accounts);
  const killSwitch = createPortalKillSwitchMiddleware(settingsRepo, 30_000);
  const generalRateLimiter = createPortalGeneralRateLimiter({ windowMs: 60_000, limit: 1000 });
  const ticketCreateRateLimiter = createPortalTicketCreateRateLimiter({ windowMs: 60_000, limit: 5 });

  const app = express();
  app.use(express.json());
  app.use(
    '/api/portal',
    createPortalRouter({
      portalLogin,
      refreshPortalSession,
      logoutPortal,
      changePortalPassword,
      portalAuthMiddleware,
      killSwitch,
      generalRateLimiter,
      getPortalMe,
      listPortalInvoices,
      listPortalPlans,
      listPortalTasks,
      listPortalTickets,
      getPortalTicket,
      createPortalTicket,
      deleteMyPortalAccount,
      ticketCreateRateLimiter,
    }),
  );

  return { app, accounts, sessions, hasher, tokenService, customers, scheduling, ticketRepo, areaRepo };
}

async function createAccountAndToken(
  stack: ReturnType<typeof buildStack>,
  clientId: string,
  dni: string,
  password: string,
): Promise<string> {
  const account = await stack.accounts.create({ clientId, dni, passwordHash: await stack.hasher.hash(password) });
  return stack.tokenService.signAccessToken({ accountId: account.id, clientId: account.clientId });
}

describe('portal self-service + account-deletion routes — Fases 4/5/6', () => {
  describe('GET /api/portal/me', () => {
    it('devuelve nombre/estado/saldo del cliente del token (saldo calculado sobre sus facturas, fix/portal-balance-from-invoices)', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a', name: 'Ana' }));
      stack.customers.seedInvoices('client-a', [
        { id: 'i1', number: 'F-1', customerId: 'client-a', customerName: 'Ana', issueDate: '2026-01-01T00:00:00.000Z', dueDate: '2026-01-10T00:00:00.000Z', amount: 500, status: 'pendiente', lineItems: [], grInvoiceId: 'GR-1', balance: 500, grType: 'FB', currency: 'ARS', pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
      ]);
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/me').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ name: 'Ana', status: 'active', balances: [{ currency: 'ARS', amount: 500 }], lastBalanceAt: '2026-01-01T00:00:00.000Z' });
    });

    it('scenario "Cliente sin facturas espejadas": balances null, NUNCA []', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a' })); // sin facturas
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/me').set('Authorization', `Bearer ${token}`);
      expect(res.body.balances).toBeNull();
    });

    it('MULTI-MONEDA: cliente con impagas en PES (ARS) y DOL (USD) -> dos entradas en balances, jamás una suma', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a', name: 'Ana' }));
      stack.customers.seedInvoices('client-a', [
        { id: 'i1', number: 'F-1', customerId: 'client-a', customerName: 'Ana', issueDate: '2026-01-01T00:00:00.000Z', dueDate: '2026-01-10T00:00:00.000Z', amount: 500, status: 'pendiente', lineItems: [], grInvoiceId: 'GR-1', balance: 500, grType: 'FB', currency: 'PES', pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
        { id: 'i2', number: 'F-2', customerId: 'client-a', customerName: 'Ana', issueDate: '2026-02-01T00:00:00.000Z', dueDate: '2026-02-10T00:00:00.000Z', amount: 30, status: 'vencida', lineItems: [], grInvoiceId: 'GR-2', balance: 30, grType: 'FB', currency: 'DOL', pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
      ]);
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/me').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.balances).toEqual([
        { currency: 'ARS', amount: 500 },
        { currency: 'USD', amount: 30 },
      ]);
    });

    it('anti-IDOR: dos clientes seedeados, el token de A jamás ve data de B', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a', name: 'Cliente A' }));
      stack.customers.seedCustomer(makeCustomer({ id: 'client-b', name: 'Cliente B' }));
      const tokenA = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/me').set('Authorization', `Bearer ${tokenA}`);
      expect(res.body.name).toBe('Cliente A');
    });

    it('sin token -> 401', async () => {
      const stack = buildStack();
      const res = await request(stack.app).get('/api/portal/me');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/portal/invoices', () => {
    it('lista SOLO las facturas del cliente del token, sin lineItems/grInvoiceId', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a' }));
      stack.customers.seedCustomer(makeCustomer({ id: 'client-b' }));
      stack.customers.seedInvoices('client-a', [
        { id: 'i1', number: 'F-1', customerId: 'client-a', customerName: 'A', issueDate: '2026-01-01T00:00:00.000Z', dueDate: '2026-01-10T00:00:00.000Z', amount: 100, status: 'pendiente', lineItems: [], grInvoiceId: 'GR-1', balance: 50, grType: 'FB', currency: 'PES', pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
      ]);
      stack.customers.seedInvoices('client-b', [
        { id: 'i2', number: 'F-2', customerId: 'client-b', customerName: 'B', issueDate: '2026-01-01T00:00:00.000Z', dueDate: '2026-01-10T00:00:00.000Z', amount: 200, status: 'pendiente', lineItems: [], grInvoiceId: 'GR-2', balance: 100, grType: 'FB', currency: 'PES', pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
      ]);
      const tokenA = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/invoices').set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].number).toBe('F-1');
      expect(res.body.data[0].lineItems).toBeUndefined();
      expect(res.body.data[0].grInvoiceId).toBeUndefined();
    });

    it('MULTI-MONEDA: PortalInvoiceDto.currency normalizado (bug real cazado por review de la app)', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a' }));
      stack.customers.seedInvoices('client-a', [
        { id: 'i1', number: 'F-1', customerId: 'client-a', customerName: 'A', issueDate: '2026-01-01T00:00:00.000Z', dueDate: '2026-01-10T00:00:00.000Z', amount: 500, status: 'pendiente', lineItems: [], grInvoiceId: 'GR-1', balance: 500, grType: 'FB', currency: 'PES', pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
        { id: 'i2', number: 'F-2', customerId: 'client-a', customerName: 'A', issueDate: '2026-02-01T00:00:00.000Z', dueDate: '2026-02-10T00:00:00.000Z', amount: 30, status: 'vencida', lineItems: [], grInvoiceId: 'GR-2', balance: 30, grType: 'FB', currency: 'DOL', pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
      ]);
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/invoices').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const byNumber = new Map(res.body.data.map((i: { number: string; currency: string }) => [i.number, i.currency]));
      expect(byNumber.get('F-1')).toBe('ARS');
      expect(byNumber.get('F-2')).toBe('USD');
    });

    it('COHERENCIA cruzada /invoices <-> /me: la suma por moneda de la lista coincide con balances[] (mismo cliente, misma historia)', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a' }));
      stack.customers.seedInvoices('client-a', [
        { id: 'i1', number: 'F-1', customerId: 'client-a', customerName: 'A', issueDate: '2026-01-01T00:00:00.000Z', dueDate: '2026-01-10T00:00:00.000Z', amount: 500, status: 'pendiente', lineItems: [], grInvoiceId: 'GR-1', balance: 500, grType: 'FB', currency: 'PES', pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
        { id: 'i2', number: 'F-2', customerId: 'client-a', customerName: 'A', issueDate: '2026-02-01T00:00:00.000Z', dueDate: '2026-02-10T00:00:00.000Z', amount: 20, status: 'vencida', lineItems: [], grInvoiceId: 'GR-2', balance: 20, grType: 'FB', currency: 'DOL', pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
        { id: 'i3', number: 'F-3', customerId: 'client-a', customerName: 'A', issueDate: '2026-03-01T00:00:00.000Z', dueDate: '2026-03-10T00:00:00.000Z', amount: 10, status: 'vencida', lineItems: [], grInvoiceId: 'GR-3', balance: 10, grType: 'FB', currency: 'DOL', pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
      ]);
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const invoicesRes = await request(stack.app).get('/api/portal/invoices').set('Authorization', `Bearer ${token}`);
      const meRes = await request(stack.app).get('/api/portal/me').set('Authorization', `Bearer ${token}`);

      const sumByCurrency = new Map<string, number>();
      for (const inv of invoicesRes.body.data as { currency: string; balance: number | null }[]) {
        sumByCurrency.set(inv.currency, (sumByCurrency.get(inv.currency) ?? 0) + (inv.balance ?? 0));
      }

      expect(sumByCurrency.get('ARS')).toBe(500);
      expect(sumByCurrency.get('USD')).toBe(30);
      for (const entry of meRes.body.balances as { currency: string; amount: number }[]) {
        expect(sumByCurrency.get(entry.currency)).toBe(entry.amount);
      }
    });
  });

  describe('GET /api/portal/plans', () => {
    it('scenario "Cliente con contrato activo"', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a' }));
      stack.customers.seedContracts('client-a', [
        { id: 'c1', code: null, type: 'internet', plan: '50 Mb', ip: '10.0.0.1', status: 'active', startDate: '2025-01-01T00:00:00.000Z', endDate: '', address: null, lat: null, lng: null, technology: null, name: null, vendedor: null, services: [{ id: 's1', serviceCatalogId: 'sc1', name: 'INTERNET', label: null, status: 'active', notes: null, createdAt: '2025-01-01T00:00:00.000Z' }] },
      ]);
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/plans').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      // M6 — envelope unificado {data}; v2.A — contractId REINSTATED (ver
      // portalPlan.dto.ts): la app lo necesita como selector de POST /tickets.
      expect(res.body).toEqual({ data: [{ contractId: 'c1', plan: '50 Mb', type: 'internet', status: 'active', startDate: '2025-01-01T00:00:00.000Z', services: [{ name: 'INTERNET', status: 'active' }] }] });
    });
  });

  describe('GET /api/portal/tasks', () => {
    it('scenario "Cliente con visita programada": fecha, timeSlot y "agendada" — nada más (M6: envelope {data} + wire 100% inglés)', async () => {
      const stack = buildStack();
      stack.scheduling.seedTask({ id: 'task-a', customerId: 'client-a', stageId: STAGE_NUEVO, startDate: '2026-08-01T09:00:00-03:00', assigneeName: 'Tecnico X', notes: 'nota interna' });
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/tasks').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: [{ scheduledDate: '2026-08-01T09:00:00-03:00', timeSlot: 'mañana', publicStatus: 'agendada' }] });
      expect(JSON.stringify(res.body)).not.toContain('Tecnico');
      expect(JSON.stringify(res.body)).not.toContain('nota interna');
      // El nombre viejo del campo no debe sobrevivir en el wire.
      expect(JSON.stringify(res.body)).not.toContain('franja');
    });

    it('anti-IDOR: dos clientes con tareas DISTINGUIBLES (fechas distintas) — A ve SU contenido, jamás el de B (L2)', async () => {
      const stack = buildStack();
      stack.scheduling.seedTask({ id: 'task-a', customerId: 'client-a', stageId: STAGE_NUEVO, startDate: '2026-08-01T09:00:00-03:00' });
      stack.scheduling.seedTask({ id: 'task-b', customerId: 'client-b', stageId: STAGE_NUEVO, startDate: '2026-09-15T15:00:00-03:00' });
      const tokenA = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/tasks').set('Authorization', `Bearer ${tokenA}`);
      // L2 — assert del CONTENIDO, no solo del length: si el filtro de scope se
      // rompiera devolviendo "una" tarea cualquiera, el length solo no lo caza.
      expect(res.body.data).toEqual([
        { scheduledDate: '2026-08-01T09:00:00-03:00', timeSlot: 'mañana', publicStatus: 'agendada' },
      ]);
      expect(JSON.stringify(res.body)).not.toContain('2026-09-15');
    });
  });

  describe('GET/POST /api/portal/tickets', () => {
    it('scenario "Cliente crea un reclamo": queda creado, asociado a su cliente, visible al instante', async () => {
      const stack = buildStack();
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const created = await request(stack.app)
        .post('/api/portal/tickets')
        .set('Authorization', `Bearer ${token}`)
        .send({ subject: 'No anda internet', description: 'Desde ayer' });
      expect(created.status).toBe(201);
      expect(created.body.subject).toBe('No anda internet');
      expect(created.body.status).toBe('open');

      const listed = await request(stack.app).get('/api/portal/tickets').set('Authorization', `Bearer ${token}`);
      expect(listed.body.data).toHaveLength(1);
      expect(listed.body.data[0].subject).toBe('No anda internet');
    });

    it('scenario "Payload inválido": falta subject/description -> 400', async () => {
      const stack = buildStack();
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).post('/api/portal/tickets').set('Authorization', `Bearer ${token}`).send({ subject: '' });
      expect(res.status).toBe(400);
    });

    it('anti-IDOR: GET /tickets del cliente A jamás incluye tickets de B', async () => {
      const stack = buildStack();
      const tokenA = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');
      const tokenB = await createAccountAndToken(stack, 'client-b', '30999888', 'OtherPass1');

      await request(stack.app).post('/api/portal/tickets').set('Authorization', `Bearer ${tokenA}`).send({ subject: 'De A', description: 'd' });
      await request(stack.app).post('/api/portal/tickets').set('Authorization', `Bearer ${tokenB}`).send({ subject: 'De B', description: 'd' });

      const listedA = await request(stack.app).get('/api/portal/tickets').set('Authorization', `Bearer ${tokenA}`);
      expect(listedA.body.data.map((t: { subject: string }) => t.subject)).toEqual(['De A']);
    });
  });

  describe('POST /api/portal/tickets — v2.A portal-ticket-contract ("seleccionar el contrato primero")', () => {
    it('cliente CON contratos + contractId propio válido -> 201 y el ticket queda con ese contrato', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a' }));
      stack.customers.seedContracts('client-a', [makeContract({ id: 'contract-a1', plan: '50 Mb Simetrico' })]);
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app)
        .post('/api/portal/tickets')
        .set('Authorization', `Bearer ${token}`)
        .send({ subject: 'No anda internet', description: 'Desde ayer', contractId: 'contract-a1' });

      expect(res.status).toBe(201);
      expect(res.body.contractId).toBe('contract-a1');
      expect(res.body.contractLabel).toBe('50 Mb Simetrico');
    });

    it('cliente CON contratos y SIN contractId -> 400 CONTRACT_REQUIRED', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a' }));
      stack.customers.seedContracts('client-a', [makeContract({ id: 'contract-a1' })]);
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app)
        .post('/api/portal/tickets')
        .set('Authorization', `Bearer ${token}`)
        .send({ subject: 'No anda internet', description: 'Desde ayer' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CONTRACT_REQUIRED');
    });

    it('contractId de OTRO cliente -> 404 con body IDÉNTICO al de un contractId inexistente (anti-enumeración)', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a' }));
      stack.customers.seedCustomer(makeCustomer({ id: 'client-b' }));
      stack.customers.seedContracts('client-a', [makeContract({ id: 'contract-a1' })]);
      stack.customers.seedContracts('client-b', [makeContract({ id: 'contract-b1' })]);
      const tokenA = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const foreignRes = await request(stack.app)
        .post('/api/portal/tickets')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ subject: 'No anda', description: 'd', contractId: 'contract-b1' });
      const missingRes = await request(stack.app)
        .post('/api/portal/tickets')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ subject: 'No anda', description: 'd', contractId: 'no-existe' });

      expect(foreignRes.status).toBe(404);
      expect(missingRes.status).toBe(404);
      expect(foreignRes.body).toEqual(missingRes.body);
    });

    it('cliente SIN contratos y sin contractId -> 201 con contractId: null (igual tiene derecho a pedir soporte)', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a' })); // sin seedContracts -> []
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app)
        .post('/api/portal/tickets')
        .set('Authorization', `Bearer ${token}`)
        .send({ subject: 'No anda internet', description: 'Desde ayer' });

      expect(res.status).toBe(201);
      expect(res.body.contractId).toBeNull();
      expect(res.body.contractLabel).toBeNull();
    });
  });

  describe('GET /api/portal/tickets/:number (C3 — navegable con el DTO, sin UUID)', () => {
    it('navegación REAL de la app: POST 201 devuelve `number` → GET /tickets/{number} da el detalle (sin tocar el repo)', async () => {
      const stack = buildStack();
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');
      const created = await request(stack.app).post('/api/portal/tickets').set('Authorization', `Bearer ${token}`).send({ subject: 'Falla', description: 'detalle' });
      expect(created.status).toBe(201);
      expect(created.body.number).toEqual(expect.any(Number));

      const res = await request(stack.app).get(`/api/portal/tickets/${created.body.number}`).set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.subject).toBe('Falla');
      expect(res.body.number).toBe(created.body.number);
      expect(res.body.comments).toBeUndefined();
      expect(res.body.id).toBeUndefined();
    });

    it('navegación vía lista: el `number` del DTO de GET /tickets alcanza para pedir el detalle', async () => {
      const stack = buildStack();
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');
      await request(stack.app).post('/api/portal/tickets').set('Authorization', `Bearer ${token}`).send({ subject: 'Desde lista', description: 'd' });

      const listed = await request(stack.app).get('/api/portal/tickets').set('Authorization', `Bearer ${token}`);
      const number: number = listed.body.data[0].number;

      const res = await request(stack.app).get(`/api/portal/tickets/${number}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.subject).toBe('Desde lista');
    });

    it('scenario "Ticket ajeno": 404 idéntico a un number inexistente', async () => {
      const stack = buildStack();
      const tokenA = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');
      const tokenB = await createAccountAndToken(stack, 'client-b', '30999888', 'OtherPass1');
      const createdB = await request(stack.app).post('/api/portal/tickets').set('Authorization', `Bearer ${tokenB}`).send({ subject: 'De B', description: 'd' });

      const foreignRes = await request(stack.app).get(`/api/portal/tickets/${createdB.body.number}`).set('Authorization', `Bearer ${tokenA}`);
      const missingRes = await request(stack.app).get('/api/portal/tickets/999999').set('Authorization', `Bearer ${tokenA}`);

      expect(foreignRes.status).toBe(404);
      expect(missingRes.status).toBe(404);
      expect(foreignRes.body).toEqual(missingRes.body);
    });

    it(':number no entero positivo CANÓNICO -> 400 VALIDATION_ERROR (parseo estricto: sin ceros a la izquierda, nunca 500 ni lookup)', async () => {
      const stack = buildStack();
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      // '01'/'007' (re-review LOW): alias no canónicos del mismo recurso — cada
      // ticket debe tener UNA sola URL; ceros a la izquierda son 400, no un lookup.
      for (const bad of ['abc', '1.5', '-1', '0', '1e3', '00x', '01', '007', `${2 ** 32}`]) {
        const res = await request(stack.app).get(`/api/portal/tickets/${bad}`).set('Authorization', `Bearer ${token}`);
        expect({ value: bad, status: res.status }).toEqual({ value: bad, status: 400 });
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
    });
  });

  describe('M2 (fix wave) — paginado basura: parseo estricto en TODAS las rutas paginadas del portal', () => {
    it('GET /tickets?page=abc → 200 con default page=1 (nunca NaN al repo, nunca 500)', async () => {
      const stack = buildStack();
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');
      await request(stack.app).post('/api/portal/tickets').set('Authorization', `Bearer ${token}`).send({ subject: 'T', description: 'd' });

      const res = await request(stack.app).get('/api/portal/tickets?page=abc&limit=xyz').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(25);
      expect(res.body.data).toHaveLength(1);
    });

    it('GET /tickets?limit=999999 → cap 25, propio de esta ruta (F7 fix wave: N+1 de unreadCount, techo más bajo que el general de 100)', async () => {
      const stack = buildStack();
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/tickets?limit=999999').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(25);
    });

    it('GET /invoices?page=-3&limit=999999 → 200 con page=1 y limit cap 100 (mismo helper, misma clase de fix)', async () => {
      const stack = buildStack();
      stack.customers.seedCustomer(makeCustomer({ id: 'client-a' }));
      const token = await createAccountAndToken(stack, 'client-a', '30111222', 'Secret123');

      const res = await request(stack.app).get('/api/portal/invoices?page=-3&limit=999999').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(100);
    });
  });

  describe('DELETE /api/portal/account', () => {
    it('scenario "Cliente borra su cuenta desde la app": 204, y el próximo refresh da 401', async () => {
      const stack = buildStack();
      const account = await stack.accounts.create({ clientId: 'client-a', dni: '30111222', passwordHash: await stack.hasher.hash('Secret123') });
      const token = stack.tokenService.signAccessToken({ accountId: account.id, clientId: account.clientId });
      const loginRes = await request(stack.app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'Secret123' });
      const refreshToken: string = loginRes.body.refreshToken;

      const res = await request(stack.app).delete('/api/portal/account').set('Authorization', `Bearer ${token}`).send({ password: 'Secret123' });
      expect(res.status).toBe(204);

      const afterDelete = await request(stack.app).post('/api/portal/auth/refresh').send({ refreshToken });
      expect(afterDelete.status).toBe(401);

      const loginAfterDelete = await request(stack.app).post('/api/portal/auth/login').send({ dni: '30111222', password: 'Secret123' });
      expect(loginAfterDelete.status).toBe(401);
    });

    it('scenario "Confirmación incorrecta": 401 y la cuenta queda intacta', async () => {
      const stack = buildStack();
      const account = await stack.accounts.create({ clientId: 'client-a', dni: '30111222', passwordHash: await stack.hasher.hash('Secret123') });
      const token = stack.tokenService.signAccessToken({ accountId: account.id, clientId: account.clientId });

      const res = await request(stack.app).delete('/api/portal/account').set('Authorization', `Bearer ${token}`).send({ password: 'WrongPass' });
      expect(res.status).toBe(401);

      const stillThere = await stack.accounts.findById(account.id);
      expect(stillThere).not.toBeNull();
    });

    it('no borra la cuenta de OTRO cliente (anti-IDOR: dos cuentas seedeadas)', async () => {
      const stack = buildStack();
      const accountA = await stack.accounts.create({ clientId: 'client-a', dni: '30111222', passwordHash: await stack.hasher.hash('Secret123') });
      const accountB = await stack.accounts.create({ clientId: 'client-b', dni: '30999888', passwordHash: await stack.hasher.hash('OtherPass1') });
      const tokenA = stack.tokenService.signAccessToken({ accountId: accountA.id, clientId: accountA.clientId });

      await request(stack.app).delete('/api/portal/account').set('Authorization', `Bearer ${tokenA}`).send({ password: 'Secret123' });

      expect(await stack.accounts.findById(accountA.id)).toBeNull();
      expect(await stack.accounts.findById(accountB.id)).not.toBeNull();
    });
  });
});
