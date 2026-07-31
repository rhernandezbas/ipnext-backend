/**
 * customer-portal-api (Fase 5, task 5.1) — ListPortalTickets. Usa el
 * InMemoryTicketRepository compartido (adapter real).
 *
 * v2.B (portal-ticket-messaging) — gana `TicketCommentRepository` para resolver
 * `unreadCount` por ticket (spec "No leídos por lado").
 */
import { ListPortalTickets } from '@application/use-cases/portal/ListPortalTickets';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';

describe('ListPortalTickets — customer-portal-api Fase 5.1', () => {
  it('lista numero, asunto, status y fechas — SOLO del cliente del token', async () => {
    const repo = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    await repo.create({ subject: 'No anda internet', description: 'desde ayer', customerId: 'client-a' });
    const useCase = new ListPortalTickets(repo, comments);

    const result = await useCase.execute('client-a', {});

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ subject: 'No anda internet', status: 'open', unreadCount: 0 });
    expect(result.data[0]!.number).toEqual(expect.any(Number));
    expect(result.data[0]!.createdAt).toEqual(expect.any(String));
  });

  it('anti-IDOR: dos clientes seedeados, cada llamada ve SOLO sus propios tickets', async () => {
    const repo = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    await repo.create({ subject: 'Ticket A', description: 'd', customerId: 'client-a' });
    await repo.create({ subject: 'Ticket B1', description: 'd', customerId: 'client-b' });
    await repo.create({ subject: 'Ticket B2', description: 'd', customerId: 'client-b' });
    const useCase = new ListPortalTickets(repo, comments);

    const a = await useCase.execute('client-a', {});
    const b = await useCase.execute('client-b', {});

    expect(a.data.map((t) => t.subject)).toEqual(['Ticket A']);
    expect(b.data.map((t) => t.subject).sort()).toEqual(['Ticket B1', 'Ticket B2']);
  });

  it('v2.B: unreadCount cuenta los públicos de staff después del cursor de lectura del cliente', async () => {
    const repo = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    const ticket = await repo.create({ subject: 'T', description: 'd', customerId: 'client-a' });
    await comments.create({
      id: 'm1', ticketId: ticket.id, authorId: null, authorKind: 'staff', visibility: 'public',
      authorName: 'Soporte', body: 'Ya lo estamos viendo', createdAt: new Date().toISOString(), attachments: [],
    });
    // Un interno NO debe contar como no-leído del cliente.
    await comments.create({
      id: 'm2', ticketId: ticket.id, authorId: null, authorKind: 'staff', visibility: 'internal',
      authorName: 'Soporte', body: 'nota interna', createdAt: new Date().toISOString(), attachments: [],
    });
    const useCase = new ListPortalTickets(repo, comments);

    const result = await useCase.execute('client-a', {});

    expect(result.data[0]!.unreadCount).toBe(1);
  });
});
