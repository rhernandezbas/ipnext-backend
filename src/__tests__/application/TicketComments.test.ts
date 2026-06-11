import { AddTicketComment } from '../../application/use-cases/AddTicketComment';
import { ListTicketComments } from '../../application/use-cases/ListTicketComments';
import { InMemoryTicketCommentRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryTicketRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { TicketNotFoundError } from '../../domain/errors';

async function seedTicket(ticketRepo: InMemoryTicketRepository): Promise<string> {
  const t = await ticketRepo.create({ subject: 'S', description: 'D' });
  return t.id;
}

describe('ListTicketComments', () => {
  it('returns empty array for an existing ticket with no comments', async () => {
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketRepo = new InMemoryTicketRepository();
    const ticketId = await seedTicket(ticketRepo);
    const uc = new ListTicketComments(commentRepo, ticketRepo);

    const result = await uc.execute(ticketId);

    expect(result).toEqual([]);
  });

  it('returns comments in createdAt ASC order', async () => {
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketRepo = new InMemoryTicketRepository();
    const ticketId = await seedTicket(ticketRepo);
    const add = new AddTicketComment(commentRepo, ticketRepo);
    const list = new ListTicketComments(commentRepo, ticketRepo);

    await add.execute({ ticketId, authorName: 'A', body: 'first', attachments: [] });
    await add.execute({ ticketId, authorName: 'B', body: 'second', attachments: [] });

    const result = await list.execute(ticketId);

    expect(result).toHaveLength(2);
    expect(result[0].body).toBe('first');
    expect(result[1].body).toBe('second');
    expect(result[0].createdAt <= result[1].createdAt).toBe(true);
  });

  it('throws TicketNotFoundError when the ticket does not exist', async () => {
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketRepo = new InMemoryTicketRepository();
    const uc = new ListTicketComments(commentRepo, ticketRepo);

    await expect(uc.execute('missing')).rejects.toBeInstanceOf(TicketNotFoundError);
  });
});

describe('AddTicketComment', () => {
  it('roundtrips a comment with id, createdAt, ticketId and attachments', async () => {
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketRepo = new InMemoryTicketRepository();
    const ticketId = await seedTicket(ticketRepo);
    const uc = new AddTicketComment(commentRepo, ticketRepo);

    const comment = await uc.execute({
      ticketId,
      authorName: 'Tech',
      body: 'With image',
      attachments: [{ url: 'data:image/png;base64,AAAA', filename: 's.png', mimeType: 'image/png', sizeBytes: 3 }],
    });

    expect(comment.id).toBeTruthy();
    expect(comment.createdAt).toBeTruthy();
    expect(comment.ticketId).toBe(ticketId);
    expect(comment.body).toBe('With image');
    expect(comment.authorName).toBe('Tech');
    expect(comment.attachments).toHaveLength(1);
    expect(comment.attachments[0].commentId).toBe(comment.id);
    expect(comment.attachments[0].url).toBe('data:image/png;base64,AAAA');
  });

  it('throws TicketNotFoundError when the ticket does not exist', async () => {
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketRepo = new InMemoryTicketRepository();
    const uc = new AddTicketComment(commentRepo, ticketRepo);

    await expect(
      uc.execute({ ticketId: 'missing', authorName: 'X', body: 'hi', attachments: [] }),
    ).rejects.toBeInstanceOf(TicketNotFoundError);
  });
});
