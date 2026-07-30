/**
 * customer-portal-api (Fase 5, task 5.1) — ListPortalTickets. Usa el
 * InMemoryTicketRepository compartido (adapter real).
 */
import { ListPortalTickets } from '@application/use-cases/portal/ListPortalTickets';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';

describe('ListPortalTickets — customer-portal-api Fase 5.1', () => {
  it('lista numero, asunto, status y fechas — SOLO del cliente del token', async () => {
    const repo = new InMemoryTicketRepository();
    await repo.create({ subject: 'No anda internet', description: 'desde ayer', customerId: 'client-a' });
    const useCase = new ListPortalTickets(repo);

    const result = await useCase.execute('client-a', {});

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ subject: 'No anda internet', status: 'open' });
    expect(result.data[0]!.number).toEqual(expect.any(Number));
    expect(result.data[0]!.createdAt).toEqual(expect.any(String));
  });

  it('anti-IDOR: dos clientes seedeados, cada llamada ve SOLO sus propios tickets', async () => {
    const repo = new InMemoryTicketRepository();
    await repo.create({ subject: 'Ticket A', description: 'd', customerId: 'client-a' });
    await repo.create({ subject: 'Ticket B1', description: 'd', customerId: 'client-b' });
    await repo.create({ subject: 'Ticket B2', description: 'd', customerId: 'client-b' });
    const useCase = new ListPortalTickets(repo);

    const a = await useCase.execute('client-a', {});
    const b = await useCase.execute('client-b', {});

    expect(a.data.map((t) => t.subject)).toEqual(['Ticket A']);
    expect(b.data.map((t) => t.subject).sort()).toEqual(['Ticket B1', 'Ticket B2']);
  });
});
