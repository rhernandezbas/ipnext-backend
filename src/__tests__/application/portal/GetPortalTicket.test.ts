/**
 * customer-portal-api (Fase 5, task 5.1) — GetPortalTicket.
 *
 * portal-self-service spec "Ticket ajeno por id": 404 IDENTICO para "no existe"
 * y "es de otro cliente" — este test prueba que el use case devuelve `null` en
 * AMBOS casos (la ruta es la que decide el 404, pero el use case no debe filtrar
 * la diferencia via ningun otro medio, p.ej. lanzando errores distintos).
 */
import { GetPortalTicket } from '@application/use-cases/portal/GetPortalTicket';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';

describe('GetPortalTicket — customer-portal-api Fase 5.1', () => {
  it('devuelve el detalle SIN comentarios cuando el ticket es del cliente', async () => {
    const repo = new InMemoryTicketRepository();
    const ticket = await repo.create({ subject: 'No anda internet', description: 'desde ayer', customerId: 'client-a' });
    const useCase = new GetPortalTicket(repo);

    const result = await useCase.execute('client-a', ticket.id);

    expect(result).toEqual({
      number: ticket.sequenceNumber,
      subject: 'No anda internet',
      description: 'desde ayer',
      status: 'open',
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    });
    expect((result as unknown as Record<string, unknown>)['comments']).toBeUndefined();
  });

  it('id inexistente -> null', async () => {
    const repo = new InMemoryTicketRepository();
    const useCase = new GetPortalTicket(repo);

    const result = await useCase.execute('client-a', 'no-existe');

    expect(result).toBeNull();
  });

  it('anti-IDOR (scenario "Ticket ajeno por id"): ticket de OTRO cliente -> null, IGUAL que inexistente', async () => {
    const repo = new InMemoryTicketRepository();
    const ticketB = await repo.create({ subject: 'Ticket de B', description: 'd', customerId: 'client-b' });
    const useCase = new GetPortalTicket(repo);

    const resultForForeignTicket = await useCase.execute('client-a', ticketB.id);
    const resultForMissingTicket = await useCase.execute('client-a', 'no-existe');

    expect(resultForForeignTicket).toBeNull();
    expect(resultForForeignTicket).toEqual(resultForMissingTicket);
  });
});
