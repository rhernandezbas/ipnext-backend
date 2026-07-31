/**
 * portal-ticket-messaging (v2.B) — SendStaffTicketReply.
 *
 * Contraparte staff de `SendPortalTicketMessage`: siempre `authorKind=staff` +
 * `visibility=public` — fijo, sin parámetro. `AddTicketComment.test.ts`
 * (TicketComments.test.ts) sigue cubriendo la nota interna (staff+internal, sin
 * cambios de contrato); este archivo cubre la CONTRAPARTE pública.
 */
import { SendStaffTicketReply } from '@application/use-cases/SendStaffTicketReply';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { TicketNotFoundError } from '@domain/errors';

function makeUseCase() {
  const tickets = new InMemoryTicketRepository();
  const comments = new InMemoryTicketCommentRepository();
  const storage = new InMemoryFileStorage();
  return { tickets, comments, storage, useCase: new SendStaffTicketReply(comments, tickets, storage) };
}

describe('SendStaffTicketReply — portal-ticket-messaging v2.B', () => {
  it('scenario "Respuesta al cliente": crea SIEMPRE authorKind=staff + visibility=public', async () => {
    const { tickets, useCase } = makeUseCase();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    const comment = await useCase.execute({
      ticketId: ticket.id, authorId: 'staff-1', authorName: 'Ana', body: 'Ya lo estamos viendo', files: [],
    });

    expect(comment.authorKind).toBe('staff');
    expect(comment.visibility).toBe('public');
    expect(comment.authorId).toBe('staff-1');
  });

  it('ticket inexistente -> TicketNotFoundError, no crea nada', async () => {
    const { comments, useCase } = makeUseCase();

    await expect(
      useCase.execute({ ticketId: 'missing', authorId: 'staff-1', authorName: 'Ana', body: 'x', files: [] }),
    ).rejects.toBeInstanceOf(TicketNotFoundError);
    expect(await comments.listByTicket('missing')).toHaveLength(0);
  });

  it('un mensaje público de staff NO afecta la nota interna existente — conviven en el mismo ticket', async () => {
    const { tickets, comments, useCase } = makeUseCase();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    await comments.create({
      id: 'internal-1', ticketId: ticket.id, authorId: null, authorKind: 'staff', visibility: 'internal',
      authorName: 'Ana', body: 'nota interna vieja', createdAt: new Date().toISOString(), attachments: [],
    });

    await useCase.execute({ ticketId: ticket.id, authorId: 'staff-1', authorName: 'Ana', body: 'respuesta pública', files: [] });

    const all = await comments.listByTicket(ticket.id);
    expect(all).toHaveLength(2);
    expect(all.find((c) => c.id === 'internal-1')!.visibility).toBe('internal');
    expect(all.find((c) => c.body === 'respuesta pública')!.visibility).toBe('public');
  });
});
