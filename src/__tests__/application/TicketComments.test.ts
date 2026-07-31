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
    // #44 flake fix: AddTicketComment stamps createdAt = new Date().toISOString(),
    // so two rapid calls can collide on the same millisecond → order becomes
    // tiebreaker-dependent (flaky). Seed with EXPLICIT distinct timestamps and
    // insert out of order so ASC sorting is what's actually asserted.
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketRepo = new InMemoryTicketRepository();
    const ticketId = await seedTicket(ticketRepo);
    const list = new ListTicketComments(commentRepo, ticketRepo);

    // Insert "second" (later timestamp) BEFORE "first" (earlier timestamp).
    await commentRepo.create({
      id: 'c-second',
      ticketId,
      authorId: null,
      authorKind: 'staff',
      visibility: 'internal',
      authorName: 'B',
      body: 'second',
      createdAt: '2026-01-01T00:00:02.000Z',
      attachments: [],
    });
    await commentRepo.create({
      id: 'c-first',
      ticketId,
      authorId: null,
      authorKind: 'staff',
      visibility: 'internal',
      authorName: 'A',
      body: 'first',
      createdAt: '2026-01-01T00:00:01.000Z',
      attachments: [],
    });

    const result = await list.execute(ticketId);

    expect(result).toHaveLength(2);
    expect(result[0].body).toBe('first');
    expect(result[1].body).toBe('second');
    expect(result[0].createdAt < result[1].createdAt).toBe(true);
  });

  it('throws TicketNotFoundError when the ticket does not exist', async () => {
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketRepo = new InMemoryTicketRepository();
    const uc = new ListTicketComments(commentRepo, ticketRepo);

    await expect(uc.execute('missing')).rejects.toBeInstanceOf(TicketNotFoundError);
  });

  it('F5 (fix wave): el cursor staffMessagesReadAt usa el createdAt del ÚLTIMO comentario LISTADO, no now()', async () => {
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketRepo = new InMemoryTicketRepository();
    const ticketId = await seedTicket(ticketRepo);
    await commentRepo.create({
      id: 'c-1', ticketId, authorId: 'acc-1', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'sigue sin andar', createdAt: '2026-01-01T00:00:01.000Z', attachments: [],
    });
    const list = new ListTicketComments(commentRepo, ticketRepo);

    await list.execute(ticketId);

    const reloaded = await ticketRepo.getById(ticketId);
    expect(reloaded!.staffMessagesReadAt).toBe('2026-01-01T00:00:01.000Z');

    // Un mensaje que "aterriza" después del listado (createdAt posterior al
    // último listado, muy anterior al now() real del test run) sigue no-leído.
    await commentRepo.create({
      id: 'c-2', ticketId, authorId: 'acc-1', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'sigue el problema', createdAt: '2026-01-01T00:00:02.000Z', attachments: [],
    });
    const since = reloaded!.staffMessagesReadAt ? new Date(reloaded!.staffMessagesReadAt) : null;
    expect(await commentRepo.countUnread(ticketId, 'staff', since)).toBe(1);
  });

  it('G4 (fix wave FINAL): ticket VACÍO (sin comentarios) — el cursor usa el instante ANTES del list(), no el momento después de listar', async () => {
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketRepo = new InMemoryTicketRepository();
    const ticketId = await seedTicket(ticketRepo);
    // Ticket recién creado, sin comentarios — el caso MÁS frecuente (todo
    // ticket nace así). Bajo el bug, la rama vacía usaba now() capturado
    // DESPUÉS de listByTicket: si el cliente escribe justo en la ventana de
    // I/O de esa query, ese primer comentario quedaba marcado leído por el
    // staff sin haberse mostrado nunca.
    const list = new ListTicketComments(commentRepo, ticketRepo);

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z')); // t0: justo antes de listar

    const originalListByTicket = commentRepo.listByTicket.bind(commentRepo);
    jest.spyOn(commentRepo, 'listByTicket').mockImplementation(async (tId: string) => {
      const result = await originalListByTicket(tId);
      // Simula el tiempo que tarda la query real — ventana en la que el
      // cliente puede escribir ANTES de que markMessagesRead corra.
      jest.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
      return result;
    });

    try {
      await list.execute(ticketId);
    } finally {
      jest.useRealTimers();
    }

    const reloaded = await ticketRepo.getById(ticketId);
    // El cursor DEBE quedar en t0, NUNCA en el instante posterior — cualquier
    // comentario que "aterrice" en esa ventana sigue contando como no-leído.
    expect(reloaded!.staffMessagesReadAt).toBe('2026-01-01T00:00:00.000Z');
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
