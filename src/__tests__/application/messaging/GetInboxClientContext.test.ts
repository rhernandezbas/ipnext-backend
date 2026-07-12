/**
 * messaging-inbox-v2 (F1.5, B3) — GetInboxClientContext. Composes the ALREADY-tested
 * per-client use cases (design.md, RICH-2) behind ONE lazy aggregate. Test layout
 * mirrors GetConversation.test.ts / GetClientDetail.test.ts:
 *  - ConversationRepository → InMemoryConversationRepository (real).
 *  - TicketRepository → InMemoryTicketRepository (real).
 *  - SchedulingRepository → InMemorySchedulingRepository (real).
 *  - PppoeServiceRepository → InMemoryPppoeServiceRepository (real).
 *  - CustomerRepository → NO in-memory adapter exists for this port (tasks.md B3
 *    note) — hand-rolled fake via jest.fn() per method, same pattern as
 *    GetClientDetail.test.ts's makeRepo().
 *
 * Numbers (#N) reference the scenario list in spec.md §"Test scenarios (resumen)".
 */
import { GetInboxClientContext } from '@application/use-cases/messaging/GetInboxClientContext';
import { GetClientContextByPhone } from '@application/use-cases/messaging/GetClientContextByPhone';
import { GetClientContracts } from '@application/use-cases/GetClientContracts';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { ListTickets } from '@application/use-cases/ListTickets';
import { ListTasks } from '@application/use-cases/ListTasks';
import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { ClientIdNotACandidateError, ConversationNotFoundError } from '@domain/errors/messaging';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Customer, Contract } from '@domain/entities/customer';
import type { Invoice } from '@domain/entities/billing';

function makeCustomer(overrides: Partial<Customer> & Pick<Customer, 'id' | 'name'>): Customer {
  return {
    email: 'client@test.com',
    phone: '+5492324421234',
    status: 'active',
    address: 'Calle 123',
    city: 'Rosario',
    country: 'AR',
    login: 'user',
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeCustomerRepo(overrides?: Partial<CustomerRepository>): CustomerRepository {
  return {
    list: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    stats: jest.fn(),
    listContracts: jest.fn().mockResolvedValue([]),
    listInvoices: jest.fn().mockResolvedValue([]),
    listLogs: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 5 }),
    updateLocation: jest.fn(),
    listActiveContacts: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeContract(overrides: Partial<Contract> & Pick<Contract, 'id'>): Contract {
  return {
    code: null,
    type: 'internet',
    plan: 'Plan Full',
    ip: '',
    status: 'active',
    startDate: '2024-01-01',
    endDate: '',
    address: 'Calle 123',
    lat: null,
    lng: null,
    technology: 'fibra',
    name: null,
    vendedor: null,
    services: [],
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<Invoice> & Pick<Invoice, 'id'>): Invoice {
  return {
    number: 'A-0001',
    customerId: 'c1',
    customerName: 'Juan Perez',
    issueDate: '2026-07-01',
    dueDate: '2026-07-15',
    amount: 1000,
    status: 'pendiente',
    lineItems: [],
    grInvoiceId: null,
    balance: 1000,
    grType: null,
    currency: 'ARS',
    pdfUrl: null,
    couponPdfUrl: null,
    paymentUrl: null,
    ...overrides,
  };
}

interface Harness {
  uc: GetInboxClientContext;
  conversationRepo: InMemoryConversationRepository;
  customerRepo: CustomerRepository;
  ticketRepo: InMemoryTicketRepository;
  schedulingRepo: InMemorySchedulingRepository;
  pppoeRepo: InMemoryPppoeServiceRepository;
}

function buildUseCase(
  opts: {
    customerRepo?: CustomerRepository;
    ticketRepo?: InMemoryTicketRepository;
    schedulingRepo?: InMemorySchedulingRepository;
    pppoeRepo?: InMemoryPppoeServiceRepository;
    refreshBalance?: RefreshClientBalanceIfStale;
    now?: () => Date;
    /** fix-be #1 — permite pinear el TTL configurado (app.ts pasa
     * config.gestionReal.balanceStaleTtlMinutes; antes del fix quedaba en 60 hardcoded). */
    ttlMinutes?: number;
  } = {},
): Harness {
  const conversationRepo = new InMemoryConversationRepository();
  const customerRepo = opts.customerRepo ?? makeCustomerRepo();
  const ticketRepo = opts.ticketRepo ?? new InMemoryTicketRepository();
  const schedulingRepo = opts.schedulingRepo ?? new InMemorySchedulingRepository();
  const pppoeRepo = opts.pppoeRepo ?? new InMemoryPppoeServiceRepository();

  const uc = new GetInboxClientContext(
    conversationRepo,
    new GetClientContextByPhone(customerRepo),
    customerRepo,
    new GetClientContracts(customerRepo),
    new GetClientInvoices(customerRepo),
    new GetClientLogs(customerRepo),
    new ListTickets(ticketRepo),
    ticketRepo,
    new ListTasks(schedulingRepo),
    new ListPppoeByContract(pppoeRepo),
    opts.refreshBalance,
    { now: opts.now, ttlMinutes: opts.ttlMinutes },
  );

  return { uc, conversationRepo, customerRepo, ticketRepo, schedulingRepo, pppoeRepo };
}

describe('GetInboxClientContext', () => {
  it('#1 matched — resuelve el match unico del telefono y agrega el DTO completo del cliente', async () => {
    const customer = makeCustomer({
      id: 'c1',
      name: 'Juan Perez',
      balanceDue: 500,
      balanceCurrency: 'ARS',
      lastBalanceAt: '2026-07-11T09:50:00.000Z',
      grClienteId: '100011',
    });
    const contract = makeContract({ id: 'ctr-1' });
    const invoice = makeInvoice({ id: 'inv-1' });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest
        .fn()
        .mockResolvedValue([{ id: 'c1', name: 'Juan Perez', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
      listContracts: jest.fn().mockResolvedValue([contract]),
      listInvoices: jest.fn().mockResolvedValue([invoice]),
    });
    const { uc, conversationRepo } = buildUseCase({
      customerRepo,
      now: () => new Date('2026-07-11T10:00:00.000Z'),
    });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 1, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    expect(result.status).toBe('matched');
    expect(result.client?.id).toBe('c1');
    expect(result.client?.fichaClientId).toBe('c1');
    expect(result.client?.balance).toEqual({
      due: 500,
      currency: 'ARS',
      isDebtor: true,
      stale: false,
      lastRefreshedAt: '2026-07-11T09:50:00.000Z',
    });
    expect(result.client?.lastInvoice?.id).toBe('inv-1');
    expect(result.client?.nextDueDate).toBe('2026-07-15');
    expect(result.client?.contracts).toEqual([
      { id: 'ctr-1', plan: 'Plan Full', status: 'active', technology: 'fibra', address: 'Calle 123', serviceStatus: null },
    ]);
    expect(result.client?.recentTickets).toEqual([]);
    expect(result.client?.recentTasks).toEqual([]);
    expect(result.client?.recentLogs).toEqual([]);
    expect(result.client?.openTicketsCount).toBe(0);
  });

  it('#2 ambiguous sin clientId — devuelve candidatos, sin agregar ningun colaborador', async () => {
    const findById = jest.fn();
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([
        { id: 'a', name: 'Cliente A', phone: '+5492324000000', email: null },
        { id: 'b', name: 'Cliente B', phone: '+5492324000000', email: null },
      ]),
      findById,
    });
    const { uc, conversationRepo } = buildUseCase({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 2, contactPhone: '+5492324000000' });

    const result = await uc.execute(conv.id);

    expect(result).toEqual({
      status: 'ambiguous',
      candidates: [
        { id: 'a', name: 'Cliente A', status: 'active' },
        { id: 'b', name: 'Cliente B', status: 'active' },
      ],
    });
    expect(findById).not.toHaveBeenCalled();
    expect(customerRepo.listContracts).not.toHaveBeenCalled();
  });

  it('#3 ambiguous con clientId valido — agrega ese candidato, status matched', async () => {
    const customerB = makeCustomer({ id: 'b', name: 'Cliente B' });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([
        { id: 'a', name: 'Cliente A', phone: '+5492324000000', email: null },
        { id: 'b', name: 'Cliente B', phone: '+5492324000000', email: null },
      ]),
      findById: jest.fn().mockResolvedValue(customerB),
    });
    const { uc, conversationRepo } = buildUseCase({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 3, contactPhone: '+5492324000000' });

    const result = await uc.execute(conv.id, { clientId: 'b' });

    expect(result.status).toBe('matched');
    expect(result.client?.id).toBe('b');
  });

  it('#4 ambiguous con clientId ajeno a los candidatos — ClientIdNotACandidateError, sin agregar nada', async () => {
    const findById = jest.fn();
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([
        { id: 'a', name: 'Cliente A', phone: '+5492324000000', email: null },
        { id: 'b', name: 'Cliente B', phone: '+5492324000000', email: null },
      ]),
      findById,
    });
    const { uc, conversationRepo } = buildUseCase({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 4, contactPhone: '+5492324000000' });

    await expect(uc.execute(conv.id, { clientId: 'z' })).rejects.toBeInstanceOf(ClientIdNotACandidateError);
    expect(findById).not.toHaveBeenCalled();
    expect(customerRepo.listContracts).not.toHaveBeenCalled();
  });

  it('#5 unknown — sin match, responde sin client ni candidates', async () => {
    const customerRepo = makeCustomerRepo({ listActiveContacts: jest.fn().mockResolvedValue([]) });
    const { uc, conversationRepo } = buildUseCase({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 5, contactPhone: '+5492324999999' });

    const result = await uc.execute(conv.id);

    expect(result).toEqual({ status: 'unknown' });
  });

  it('#6 conversationRepo.findById devuelve null — lanza ConversationNotFoundError', async () => {
    const { uc } = buildUseCase();
    await expect(uc.execute('ghost-id')).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it('#7a mas de 3 tickets abiertos — recentTickets trunca a 3 pero openTicketsCount cuenta el total real', async () => {
    const customer = makeCustomer({ id: 'c1', name: 'Juan' });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
    });
    const ticketRepo = new InMemoryTicketRepository();
    for (let i = 0; i < 7; i++) {
      await ticketRepo.create({ subject: `Ticket ${i}`, description: 'x', customerId: 'c1' });
    }
    const { uc, conversationRepo } = buildUseCase({ customerRepo, ticketRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 7, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    expect(result.client?.recentTickets).toHaveLength(3);
    expect(result.client?.openTicketsCount).toBe(7);
  });

  it('#7b mas de 3 tareas — recentTasks trunca a 3 (ListTasks no soporta limit, truncado client-side)', async () => {
    const customer = makeCustomer({ id: 'c1', name: 'Juan' });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
    });
    const schedulingRepo = new InMemorySchedulingRepository();
    for (let i = 0; i < 5; i++) {
      schedulingRepo.seedTask({ id: `task-c1-${i}`, title: `Tarea ${i}`, customerId: 'c1' });
    }
    const { uc, conversationRepo } = buildUseCase({ customerRepo, schedulingRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 8, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    expect(result.client?.recentTasks).toHaveLength(3);
  });

  it('#7c mas de 5 logs — recentLogs trunca a 5, primera pagina (GetClientLogs soporta limit nativo)', async () => {
    const customer = makeCustomer({ id: 'c1', name: 'Juan' });
    const logs = Array.from({ length: 12 }, (_, i) => ({
      id: `log-${i}`,
      timestamp: `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      eventType: 'note',
      description: `Log ${i}`,
    }));
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
      listLogs: jest.fn().mockImplementation(async (query: { page: number; limit: number }) => ({
        data: logs.slice((query.page - 1) * query.limit, (query.page - 1) * query.limit + query.limit),
        total: logs.length,
        page: query.page,
        limit: query.limit,
      })),
    });
    const { uc, conversationRepo } = buildUseCase({ customerRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 9, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    expect(result.client?.recentLogs).toHaveLength(5);
    expect(customerRepo.listLogs).toHaveBeenCalledWith({ clientId: 'c1', page: 1, limit: 5 });
  });

  it('#8 sin refresh, lastBalanceAt de hace 2h (>TTL 60min) — stale true, cero invocaciones a refreshBalance', async () => {
    const customer = makeCustomer({
      id: 'c1',
      name: 'Juan',
      grClienteId: '100011',
      lastBalanceAt: '2026-07-11T08:00:00.000Z',
    });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
    });
    const refreshBalance = { execute: jest.fn().mockResolvedValue(true) } as unknown as RefreshClientBalanceIfStale;
    const { uc, conversationRepo } = buildUseCase({
      customerRepo,
      refreshBalance,
      now: () => new Date('2026-07-11T10:00:00.000Z'),
    });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 10, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id); // NO refresh flag

    expect(result.client?.balance.stale).toBe(true);
    expect(refreshBalance.execute).not.toHaveBeenCalled();
  });

  it('#9 sin refresh, lastBalanceAt de hace 10min (<TTL) — stale false, cero invocaciones a refreshBalance', async () => {
    const customer = makeCustomer({
      id: 'c1',
      name: 'Juan',
      grClienteId: '100011',
      lastBalanceAt: '2026-07-11T09:50:00.000Z',
    });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
    });
    const refreshBalance = { execute: jest.fn().mockResolvedValue(true) } as unknown as RefreshClientBalanceIfStale;
    const { uc, conversationRepo } = buildUseCase({
      customerRepo,
      refreshBalance,
      now: () => new Date('2026-07-11T10:00:00.000Z'),
    });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 11, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    expect(result.client?.balance.stale).toBe(false);
    expect(refreshBalance.execute).not.toHaveBeenCalled();
  });

  it('#10 refresh:true y refreshBalance.execute resuelve true (GR ok) — re-lee el customer, stale false, valor actualizado', async () => {
    const staleCustomer = makeCustomer({
      id: 'c1',
      name: 'Juan',
      grClienteId: '100011',
      lastBalanceAt: '2026-07-11T08:00:00.000Z',
      balanceDue: 100,
    });
    const freshCustomer: Customer = { ...staleCustomer, balanceDue: 5000, lastBalanceAt: '2026-07-11T10:00:00.000Z' };
    const findById = jest.fn().mockResolvedValueOnce(staleCustomer).mockResolvedValueOnce(freshCustomer);
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById,
    });
    const refreshBalance = { execute: jest.fn().mockResolvedValue(true) } as unknown as RefreshClientBalanceIfStale;
    const { uc, conversationRepo } = buildUseCase({
      customerRepo,
      refreshBalance,
      now: () => new Date('2026-07-11T10:00:05.000Z'),
    });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 12, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id, { refresh: true });

    expect(refreshBalance.execute).toHaveBeenCalledWith({ grClienteId: '100011', lastBalanceAt: '2026-07-11T08:00:00.000Z' });
    expect(findById).toHaveBeenCalledTimes(2);
    expect(result.client?.balance.due).toBe(5000);
    expect(result.client?.balance.stale).toBe(false);
  });

  it('#11 refresh:true pero refreshBalance.execute resuelve false (GR fallo/timeout) — 200 con balance previo, stale true, nunca lanza', async () => {
    const customer = makeCustomer({
      id: 'c1',
      name: 'Juan',
      grClienteId: '100011',
      lastBalanceAt: '2026-07-11T08:00:00.000Z',
      balanceDue: 100,
    });
    const findById = jest.fn().mockResolvedValue(customer);
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById,
    });
    const refreshBalance = { execute: jest.fn().mockResolvedValue(false) } as unknown as RefreshClientBalanceIfStale;
    const { uc, conversationRepo } = buildUseCase({
      customerRepo,
      refreshBalance,
      now: () => new Date('2026-07-11T10:00:05.000Z'),
    });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 13, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id, { refresh: true });

    expect(result.client?.balance.due).toBe(100);
    expect(result.client?.balance.stale).toBe(true);
    expect(findById).toHaveBeenCalledTimes(1); // no re-read since the refresh did not fetch anything fresh
  });

  it('#12 fan-out en paralelo — un colaborador lento (invoices) no serializa a los demas', async () => {
    const customer = makeCustomer({ id: 'c1', name: 'Juan' });
    const callOrder: string[] = [];
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
      listContracts: jest.fn().mockImplementation(async () => {
        callOrder.push('contracts');
        return [];
      }),
      listInvoices: jest.fn().mockImplementation(
        () =>
          new Promise<unknown[]>((resolve) => {
            setTimeout(() => {
              callOrder.push('invoices-resolved');
              resolve([]);
            }, 60);
          }),
      ),
      listLogs: jest.fn().mockImplementation(async () => {
        callOrder.push('logs');
        return { data: [], total: 0, page: 1, limit: 5 };
      }),
    });
    const ticketRepo = new InMemoryTicketRepository();
    const originalCount = ticketRepo.countOpenByClientIds.bind(ticketRepo);
    jest.spyOn(ticketRepo, 'countOpenByClientIds').mockImplementation(async (ids: string[]) => {
      callOrder.push('tickets');
      return originalCount(ids);
    });
    const schedulingRepo = new InMemorySchedulingRepository();
    const originalListTasks = schedulingRepo.listTasks.bind(schedulingRepo);
    jest.spyOn(schedulingRepo, 'listTasks').mockImplementation(async (filter) => {
      callOrder.push('tasks');
      return originalListTasks(filter);
    });

    const { uc, conversationRepo } = buildUseCase({ customerRepo, ticketRepo, schedulingRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 14, contactPhone: '+5492324421234' });

    await uc.execute(conv.id);

    const resolvedIdx = callOrder.indexOf('invoices-resolved');
    expect(resolvedIdx).toBeGreaterThan(-1);
    expect(callOrder.indexOf('contracts')).toBeLessThan(resolvedIdx);
    expect(callOrder.indexOf('logs')).toBeLessThan(resolvedIdx);
    expect(callOrder.indexOf('tickets')).toBeLessThan(resolvedIdx);
    expect(callOrder.indexOf('tasks')).toBeLessThan(resolvedIdx);
  });

  it('#13 listPppoeByContract falla para un contrato — esa seccion sale null, el resto del DTO se completa igual', async () => {
    const customer = makeCustomer({ id: 'c1', name: 'Juan' });
    const contract = makeContract({ id: 'ctr-1' });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
      listContracts: jest.fn().mockResolvedValue([contract]),
    });
    const pppoeRepo = new InMemoryPppoeServiceRepository();
    jest.spyOn(pppoeRepo, 'findByContract').mockRejectedValue(new Error('pppoe repo down'));
    const { uc, conversationRepo } = buildUseCase({ customerRepo, pppoeRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 15, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    expect(result.status).toBe('matched');
    expect(result.client?.contracts).toEqual([
      { id: 'ctr-1', plan: 'Plan Full', status: 'active', technology: 'fibra', address: 'Calle 123', serviceStatus: null },
    ]);
    expect(result.client?.recentTasks).toEqual([]); // rest of the DTO completed, use case never rethrew
  });

  it('#16 nunca filtra la password de PPPoE en ningun sub-DTO', async () => {
    const customer = makeCustomer({ id: 'c1', name: 'Juan' });
    const contract = makeContract({ id: 'ctr-1' });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
      listContracts: jest.fn().mockResolvedValue([contract]),
    });
    const pppoeRepo = new InMemoryPppoeServiceRepository();
    await pppoeRepo.upsertByUsername({
      username: 'user1',
      password: 'SECRET_PASSWORD_XYZ',
      nasId: 'nas-1',
      contractId: 'ctr-1',
    });
    const { uc, conversationRepo } = buildUseCase({ customerRepo, pppoeRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 16, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    expect(JSON.stringify(result)).not.toContain('SECRET_PASSWORD_XYZ');
    expect(result.client?.contracts[0]?.serviceStatus).toBe('active'); // enabled + enforcedState active
  });

  // ─── fix-be (review adversarial) ───────────────────────────────────────────

  it('#1b [ALTO] ttlMinutes:120 configurado + balance de 90min sin refresh — stale false (documenta el contrato que app.ts debe respetar; la deriva real esta en el wiring de app.ts, pineada por messaging-composition.test.ts)', async () => {
    const customer = makeCustomer({
      id: 'c1',
      name: 'Juan',
      grClienteId: '100011',
      lastBalanceAt: '2026-07-11T08:30:00.000Z', // 90 min antes de "now"
    });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
    });
    const { uc, conversationRepo } = buildUseCase({
      customerRepo,
      ttlMinutes: 120,
      now: () => new Date('2026-07-11T10:00:00.000Z'),
    });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 17, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    // Con el TTL default (60) esto daria stale:true (90min > 60min). Con el TTL
    // custom de 120 pasado explicitamente, DEBE dar false.
    expect(result.client?.balance.stale).toBe(false);
  });

  it('#2b [MEDIO] 25 tickets cerrados + 3 abiertos — recentTickets NO sale vacio pese a openTicketsCount>0 (filtro openOnly server-side)', async () => {
    const customer = makeCustomer({ id: 'c1', name: 'Juan' });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
    });
    const ticketRepo = new InMemoryTicketRepository();
    // 25 tickets CERRADOS primero — ocupan la pagina 1/limit25 de "cualquier estado"
    // si el filtro de abiertos se hace solo client-side (bug original).
    for (let i = 0; i < 25; i++) {
      const t = await ticketRepo.create({ subject: `Cerrado ${i}`, description: 'x', customerId: 'c1' });
      await ticketRepo.close(t.id, 'closed');
    }
    // 3 tickets ABIERTOS, insertados despues — quedarian en la pagina 2 sin el fix.
    for (let i = 0; i < 3; i++) {
      await ticketRepo.create({ subject: `Abierto ${i}`, description: 'x', customerId: 'c1' });
    }
    const { uc, conversationRepo } = buildUseCase({ customerRepo, ticketRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 18, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    expect(result.client?.openTicketsCount).toBe(3);
    expect(result.client?.recentTickets.length).toBeGreaterThan(0);
    expect(result.client?.recentTickets.every((t) => t.subject.startsWith('Abierto'))).toBe(true);
  });

  it('#4b [BAJO] contrato con 2 servicios PPPoE (active + blocked) — serviceStatus colapsa al MAS SEVERO (blocked), no al primero del repo', async () => {
    const customer = makeCustomer({ id: 'c1', name: 'Juan' });
    const contract = makeContract({ id: 'ctr-1' });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
      listContracts: jest.fn().mockResolvedValue([contract]),
    });
    const pppoeRepo = new InMemoryPppoeServiceRepository();
    // El servicio "active" se inserta PRIMERO — el bug original toma services[0] (active).
    await pppoeRepo.upsertByUsername({
      username: 'svc-active', password: 'x', nasId: 'nas-1', contractId: 'ctr-1',
      status: 'enabled', enforcedState: 'active',
    });
    await pppoeRepo.upsertByUsername({
      username: 'svc-blocked', password: 'x', nasId: 'nas-1', contractId: 'ctr-1',
      status: 'enabled', enforcedState: 'blocked',
    });
    const { uc, conversationRepo } = buildUseCase({ customerRepo, pppoeRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 19, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    expect(result.client?.contracts[0]?.serviceStatus).toBe('blocked');
  });

  it('#5b [BAJO] countOpenByClientIds falla — recentTickets se puebla igual, openTicketsCount degrada a 0 (try/catch independientes por sub-consulta)', async () => {
    const customer = makeCustomer({ id: 'c1', name: 'Juan' });
    const customerRepo = makeCustomerRepo({
      listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
      findById: jest.fn().mockResolvedValue(customer),
    });
    const ticketRepo = new InMemoryTicketRepository();
    await ticketRepo.create({ subject: 'Sin señal', description: 'x', customerId: 'c1' });
    jest.spyOn(ticketRepo, 'countOpenByClientIds').mockRejectedValue(new Error('count down'));
    const { uc, conversationRepo } = buildUseCase({ customerRepo, ticketRepo });
    const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 20, contactPhone: '+5492324421234' });

    const result = await uc.execute(conv.id);

    expect(result.client?.recentTickets).toHaveLength(1);
    expect(result.client?.openTicketsCount).toBe(0);
  });
});
