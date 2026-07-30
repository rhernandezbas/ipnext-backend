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

describe('CreatePortalTicket <-> ListTickets (admin) — seam compartido, Fase 5.3', () => {
  it('scenario "Cliente crea un reclamo": visible AL INSTANTE por ListTickets admin (misma DB, mismo Ticket)', async () => {
    const sharedTicketRepo = new InMemoryTicketRepository();
    const areas = new InMemoryTicketAreaCatalogRepository();
    await areas.create({ name: 'Atención al cliente', color: '#111111' });

    const createPortalTicket = new CreatePortalTicket(sharedTicketRepo, areas);
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
});
