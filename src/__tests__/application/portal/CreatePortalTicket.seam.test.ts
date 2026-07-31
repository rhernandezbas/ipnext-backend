/**
 * customer-portal-api (Fase 5, task 5.3) — "Test del seam completo": un ticket
 * creado por el POST del portal es visible por el camino de LISTADO ADMIN
 * existente. Use case ADMIN REAL (`ListTickets`, no mockeado) + el MISMO
 * `InMemoryTicketRepository` que usa `CreatePortalTicket` — prueba que ambos
 * caminos leen/escriben la MISMA tabla `Ticket`, sin ninguna capa paralela.
 */
import { CreatePortalTicket } from '@application/use-cases/portal/CreatePortalTicket';
import { ListTickets } from '@application/use-cases/ListTickets';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketAreaCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketAreaCatalogRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { Contract } from '@domain/entities/customer';

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

const NO_CONTRACTS: Pick<CustomerRepository, 'listContracts'> = { listContracts: async () => [] };

describe('CreatePortalTicket <-> ListTickets (admin) — seam compartido, Fase 5.3', () => {
  it('scenario "Cliente crea un reclamo": visible AL INSTANTE por ListTickets admin (misma DB, mismo Ticket)', async () => {
    const sharedTicketRepo = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    await areas.create({ name: 'Atención al cliente', color: '#111111' });

    const createPortalTicket = new CreatePortalTicket(sharedTicketRepo, areas, NO_CONTRACTS);
    // use case ADMIN REAL — no un fake, el mismo que consume la ruta /api/tickets.
    const listTicketsAdmin = new ListTickets(sharedTicketRepo);

    const created = await createPortalTicket.execute('client-a', {
      subject: 'No anda internet',
      description: 'Desde ayer a la tarde',
    });

    const adminView = await listTicketsAdmin.execute({ customerId: 'client-a' });

    expect(adminView.data).toHaveLength(1);
    expect(adminView.data[0]!.subject).toBe('No anda internet');
    expect(adminView.data[0]!.sequenceNumber).toBe(created.number);
    expect(adminView.data[0]!.status).toBe('open');
  });

  it('v2.A: ticket creado CON contrato -> visible por ListTickets admin con el MISMO contractId (Ticket.contractId, FK real)', async () => {
    const sharedTicketRepo = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    await areas.create({ name: 'Atención al cliente', color: '#111111' });
    const customers: Pick<CustomerRepository, 'listContracts'> = {
      listContracts: async (clientId) => (clientId === 'client-a' ? [makeContract({ id: 'contract-a1', plan: '50 Mb Simetrico' })] : []),
    };

    const createPortalTicket = new CreatePortalTicket(sharedTicketRepo, areas, customers);
    const listTicketsAdmin = new ListTickets(sharedTicketRepo);

    const created = await createPortalTicket.execute('client-a', {
      subject: 'No anda internet',
      description: 'Desde ayer a la tarde',
      contractId: 'contract-a1',
    });

    const adminView = await listTicketsAdmin.execute({ customerId: 'client-a' });

    expect(created.contractId).toBe('contract-a1');
    expect(adminView.data).toHaveLength(1);
    expect(adminView.data[0]!.contractId).toBe('contract-a1');
  });
});
