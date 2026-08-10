/**
 * customer-balance-unmask (Fase 2, tarea 2.5) — spec `balance-staleness-helper`,
 * requirement "one staleness criterion for every caller" (S13).
 *
 * Los TRES call sites (`toCustomer`, `GetInboxClientContext.buildClientSummary`,
 * `RefreshClientBalanceIfStale`'s internal gate) deben coincidir en el MISMO
 * veredicto para el MISMO `lastBalanceAt`/`ttlMinutes` — antes de este change el
 * mapper computaba `balanceStale` con su propio criterio status-gated
 * (`isBalanceStale`, retirado en la Fase 2) y podía discrepar del inbox, que ya
 * usaba `isBalanceOlderThanTtl`. Este test ejercita los TRES caminos PÚBLICOS
 * (no llama al helper puro tres veces — sería tautológico) para probar que
 * ninguno reintrodujo un cálculo de edad propio.
 */
import { toCustomer } from '@infrastructure/adapters/prisma/PrismaCustomerRepository';
import { GetInboxClientContext } from '@application/use-cases/messaging/GetInboxClientContext';
import { GetClientContextByPhone } from '@application/use-cases/messaging/GetClientContextByPhone';
import { GetClientContracts } from '@application/use-cases/GetClientContracts';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { ListTickets } from '@application/use-cases/ListTickets';
import { ListTasks } from '@application/use-cases/ListTasks';
import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { InMemoryConversationRepository } from '@infrastructure/adapters/in-memory/InMemoryConversationRepository';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryGestionRealPort } from '@infrastructure/adapters/in-memory/InMemoryGestionRealPort';
import { InMemoryClientMirrorRepository } from '@infrastructure/adapters/in-memory/InMemoryClientMirrorRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { GrClientBalance } from '@domain/entities/gestionReal';
import { parseClientBalanceResponse } from '@infrastructure/adapters/gestion-real/GestionRealClient';
import { customerFrom, grBalancePayload } from '../helpers/customerFixture';

const NOW = () => new Date('2026-08-10T12:00:00.000Z');
const TTL_MINUTES = 60;

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
    getPortalBalanceSummary: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

async function inboxStale(lastBalanceAt: string | null): Promise<boolean> {
  const customer = customerFrom({
    id: 'c1',
    status: 'active',
    grClienteId: 'gr-1',
    lastBalanceAt: lastBalanceAt ? new Date(lastBalanceAt) : null,
  }, { ttlMinutes: TTL_MINUTES, now: NOW });
  const customerRepo = makeCustomerRepo({
    listActiveContacts: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Juan', phone: '+5492324421234', email: null }]),
    findById: jest.fn().mockResolvedValue(customer),
  });
  const conversationRepo = new InMemoryConversationRepository();
  const ticketRepo = new InMemoryTicketRepository();
  const schedulingRepo = new InMemorySchedulingRepository();
  const pppoeRepo = new InMemoryPppoeServiceRepository();
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
    undefined,
    { now: NOW, ttlMinutes: TTL_MINUTES },
  );
  const conv = await conversationRepo.upsertByChatwootId({ chatwootConversationId: 900, contactPhone: '+5492324421234' });

  const result = await uc.execute(conv.id);
  return result.status === 'matched' ? result.client!.balance.stale : true;
}

async function refreshJudgedStale(lastBalanceAt: string | null): Promise<boolean> {
  const gr = new InMemoryGestionRealPort();
  const mirror = new InMemoryClientMirrorRepository();
  // fix wave (F1) — el balance nace de un payload GR pasado por el parser real,
  // no de un `GrClientBalance` escrito a mano: la moneda la SINTETIZA el parser
  // (`amount > 0 ? 'ARS' : null`) y un literal a mano puede codificar un par
  // que la escritura real nunca produce (así vivió el CRITICAL de F1).
  const balance: GrClientBalance = parseClientBalanceResponse('gr-1', grBalancePayload('1000.00', { grClienteId: 'gr-1' }));
  gr.balancesByClient['gr-1'] = balance;
  const refresh = new RefreshClientBalanceIfStale(gr, mirror, { now: NOW, ttlMinutes: TTL_MINUTES });

  await refresh.execute({ grClienteId: 'gr-1', lastBalanceAt });
  // Si RefreshClientBalanceIfStale juzgó "fresco", NUNCA llama a GR (short-circuit interno).
  return gr.balanceCalls.includes('gr-1');
}

function mapperStale(lastBalanceAt: string | null): boolean {
  const c = customerFrom({
    status: 'active',
    grClienteId: 'gr-1',
    lastBalanceAt: lastBalanceAt ? new Date(lastBalanceAt) : null,
  }, { ttlMinutes: TTL_MINUTES, now: NOW });
  return c.balanceStale!;
}

describe('balanceStale — un solo criterio en los tres call sites (S13)', () => {
  it('lastBalanceAt fresco (10min): toCustomer, GetInboxClientContext y RefreshClientBalanceIfStale coinciden en "no stale"', async () => {
    const freshAt = new Date(NOW().getTime() - 10 * 60 * 1000).toISOString();

    expect(mapperStale(freshAt)).toBe(false);
    expect(await inboxStale(freshAt)).toBe(false);
    expect(await refreshJudgedStale(freshAt)).toBe(false);
  });

  it('lastBalanceAt viejo (90min, >TTL 60): los tres coinciden en "stale"', async () => {
    const staleAt = new Date(NOW().getTime() - 90 * 60 * 1000).toISOString();

    expect(mapperStale(staleAt)).toBe(true);
    expect(await inboxStale(staleAt)).toBe(true);
    expect(await refreshJudgedStale(staleAt)).toBe(true);
  });

  it('lastBalanceAt null (nunca fetcheado): los tres coinciden en "stale", cualquier status', async () => {
    expect(mapperStale(null)).toBe(true);
    expect(await inboxStale(null)).toBe(true);
    expect(await refreshJudgedStale(null)).toBe(true);
  });
});
