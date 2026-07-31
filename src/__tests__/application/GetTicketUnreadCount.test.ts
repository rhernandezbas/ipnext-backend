import { GetTicketUnreadCount } from '@application/use-cases/GetTicketUnreadCount';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { TicketNotFoundError } from '@domain/errors';

describe('GetTicketUnreadCount — portal-ticket-messaging v2.B (lado admin)', () => {
  it('cuenta lo escrito por el cliente después del cursor de lectura del staff', async () => {
    const tickets = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    await comments.create({
      id: 'm1', ticketId: ticket.id, authorId: 'acc-1', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'sigue sin andar', createdAt: new Date().toISOString(), attachments: [],
    });
    const useCase = new GetTicketUnreadCount(tickets, comments);

    expect(await useCase.execute(ticket.id)).toBe(1);
  });

  it('ticket inexistente -> TicketNotFoundError', async () => {
    const tickets = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    const useCase = new GetTicketUnreadCount(tickets, comments);

    await expect(useCase.execute('missing')).rejects.toBeInstanceOf(TicketNotFoundError);
  });

  it('después de markMessagesRead("staff") el contador vuelve a 0', async () => {
    const tickets = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    await comments.create({
      id: 'm1', ticketId: ticket.id, authorId: 'acc-1', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'sigue sin andar', createdAt: new Date().toISOString(), attachments: [],
    });
    await tickets.markMessagesRead(ticket.id, 'staff');
    const useCase = new GetTicketUnreadCount(tickets, comments);

    expect(await useCase.execute(ticket.id)).toBe(0);
  });
});
