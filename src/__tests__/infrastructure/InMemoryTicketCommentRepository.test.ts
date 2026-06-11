import { InMemoryTicketCommentRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { TicketComment } from '@domain/entities/ticketComment';

function comment(id: string, createdAt: string): TicketComment {
  return { id, ticketId: 't1', authorName: 'a', body: 'b', createdAt, attachments: [] };
}

describe('InMemoryTicketCommentRepository.listByTicket', () => {
  it('orders by createdAt asc', async () => {
    const repo = new InMemoryTicketCommentRepository();
    await repo.create(comment('c2', '2026-01-02T00:00:00.000Z'));
    await repo.create(comment('c1', '2026-01-01T00:00:00.000Z'));

    const list = await repo.listByTicket('t1');
    expect(list.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('breaks ties on equal createdAt deterministically by id asc', async () => {
    const repo = new InMemoryTicketCommentRepository();
    const ts = '2026-01-01T00:00:00.000Z';
    // Insert out of id order with identical createdAt.
    await repo.create(comment('b', ts));
    await repo.create(comment('a', ts));
    await repo.create(comment('c', ts));

    const list = await repo.listByTicket('t1');
    expect(list.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });
});
