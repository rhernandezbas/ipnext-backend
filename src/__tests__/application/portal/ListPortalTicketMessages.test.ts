/**
 * portal-ticket-messaging (v2.B) — ListPortalTicketMessages.
 *
 * spec ticket-messaging "El cliente lee y escribe en SU reclamo": GET solo
 * devuelve los `public` del ticket del cliente del token, en orden cronológico.
 * Este es EL test que ejercita el invariante central ("un internal NO SALE
 * JAMÁS por /api/portal/*"): ver la suite "revert-probe" abajo — invertir el
 * filtro de `InMemoryTicketCommentRepository.listPublicByTicket` (que es lo que
 * este use case consume) tiene que poner este archivo en rojo.
 */
import { ListPortalTicketMessages } from '@application/use-cases/portal/ListPortalTicketMessages';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { TicketComment } from '@domain/entities/ticketComment';

function makeComment(overrides: Partial<TicketComment> & { id: string; ticketId: string }): TicketComment {
  return {
    authorId: null,
    authorKind: 'staff',
    visibility: 'internal',
    authorName: 'Tech',
    body: 'body',
    createdAt: '2026-01-01T00:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}

describe('ListPortalTicketMessages — customer-portal-api v2.B', () => {
  it('scenario "Hilo del cliente": 2 públicos + 3 internos -> el cliente ve EXACTAMENTE 2, en orden cronológico', async () => {
    const ticketRepo = new InMemoryTicketRepository();
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticket = await ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });

    await commentRepo.create(makeComment({ id: 'internal-1', ticketId: ticket.id, visibility: 'internal', createdAt: '2026-01-01T00:00:01.000Z' }));
    await commentRepo.create(makeComment({ id: 'public-1', ticketId: ticket.id, visibility: 'public', authorKind: 'client', authorId: 'acc-a', body: 'hola', createdAt: '2026-01-01T00:00:02.000Z' }));
    await commentRepo.create(makeComment({ id: 'internal-2', ticketId: ticket.id, visibility: 'internal', createdAt: '2026-01-01T00:00:03.000Z' }));
    await commentRepo.create(makeComment({ id: 'public-2', ticketId: ticket.id, visibility: 'public', authorKind: 'staff', body: 'respuesta', createdAt: '2026-01-01T00:00:04.000Z' }));
    await commentRepo.create(makeComment({ id: 'internal-3', ticketId: ticket.id, visibility: 'internal', createdAt: '2026-01-01T00:00:05.000Z' }));

    const useCase = new ListPortalTicketMessages(ticketRepo, commentRepo);
    const result = await useCase.execute('client-a', ticket.sequenceNumber);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result!.map((m) => m.id)).toEqual(['public-1', 'public-2']);
    expect(result!.map((m) => m.authorKind)).toEqual(['client', 'staff']);
    // NUNCA debe aparecer nada de los 3 internos.
    expect(result!.some((m) => m.id.startsWith('internal'))).toBe(false);
  });

  it('scenario "Reclamo ajeno": ticket de OTRO cliente -> null (mismo contrato que GetPortalTicket)', async () => {
    const ticketRepo = new InMemoryTicketRepository();
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketB = await ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-b' });
    await commentRepo.create(makeComment({ id: 'public-1', ticketId: ticketB.id, visibility: 'public', authorKind: 'client' }));

    const useCase = new ListPortalTicketMessages(ticketRepo, commentRepo);

    expect(await useCase.execute('client-a', ticketB.sequenceNumber)).toBeNull();
    expect(await useCase.execute('client-a', 999_999)).toBeNull();
  });

  it('marca el cursor de lectura del cliente ("abrir el hilo" limpia el no-leído)', async () => {
    const ticketRepo = new InMemoryTicketRepository();
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticket = await ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    expect(ticket.clientMessagesReadAt).toBeNull();

    const useCase = new ListPortalTicketMessages(ticketRepo, commentRepo);
    await useCase.execute('client-a', ticket.sequenceNumber);

    const reloaded = await ticketRepo.getBySequenceNumber(ticket.sequenceNumber);
    expect(reloaded!.clientMessagesReadAt).toBeTruthy();
  });

  it('F5 (fix wave): el cursor usa el createdAt del ÚLTIMO mensaje LISTADO, no now() — un mensaje que "aterriza" después de leer sigue no-leído', async () => {
    const ticketRepo = new InMemoryTicketRepository();
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticket = await ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    await commentRepo.create(makeComment({
      id: 'public-1', ticketId: ticket.id, visibility: 'public', authorKind: 'staff',
      body: 'primera respuesta', createdAt: '2026-01-01T00:00:01.000Z',
    }));

    const useCase = new ListPortalTicketMessages(ticketRepo, commentRepo);
    await useCase.execute('client-a', ticket.sequenceNumber);

    // El cursor DEBE ser EXACTAMENTE el createdAt del último listado — nunca
    // now() (que en este test correría muchísimo después de estas fechas fijas
    // de 2026-01-01, ocultando cualquier mensaje "atrasado" que llegue en la
    // ventana entre el list() y el mark real de producción).
    const reloaded = await ticketRepo.getBySequenceNumber(ticket.sequenceNumber);
    expect(reloaded!.clientMessagesReadAt).toBe('2026-01-01T00:00:01.000Z');

    // Simula el mensaje que "aterriza" en la ventana de carrera: createdAt
    // POSTERIOR al último listado (el operador respondió justo ahí), pero muy
    // anterior al now() real del test — bajo el bug (cursor=now()), este
    // mensaje quedaría marcado leído sin haber estado NUNCA en la respuesta
    // del GET que el cliente recibió.
    await commentRepo.create(makeComment({
      id: 'public-2', ticketId: ticket.id, visibility: 'public', authorKind: 'staff',
      body: 'segunda respuesta (llegó después)', createdAt: '2026-01-01T00:00:02.000Z',
    }));
    const since = reloaded!.clientMessagesReadAt ? new Date(reloaded!.clientMessagesReadAt) : null;
    expect(await commentRepo.countUnread(ticket.id, 'client', since)).toBe(1);
  });

  it('NO marca el cursor cuando el ticket es ajeno (nunca "abrió" nada)', async () => {
    const ticketRepo = new InMemoryTicketRepository();
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticketB = await ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-b' });

    const useCase = new ListPortalTicketMessages(ticketRepo, commentRepo);
    await useCase.execute('client-a', ticketB.sequenceNumber);

    const reloaded = await ticketRepo.getBySequenceNumber(ticketB.sequenceNumber);
    expect(reloaded!.clientMessagesReadAt).toBeNull();
  });

  it('G4 (fix wave FINAL): hilo VACÍO — el cursor usa el instante capturado ANTES del list(), no el momento después de listar', async () => {
    const ticketRepo = new InMemoryTicketRepository();
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticket = await ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    // Hilo recién creado: SIN comentarios todavía — el caso MÁS frecuente
    // (todo ticket nace así). Bajo el bug, la rama vacía usaba now(), capturado
    // DESPUÉS de que listPublicByTicket resuelve — si el operador responde
    // justo en esa ventana (I/O real de la query no es instantáneo), ese
    // primer mensaje quedaba marcado leído sin haberse mostrado nunca.

    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z')); // t0: justo antes de listar

    const originalList = commentRepo.listPublicByTicket.bind(commentRepo);
    jest.spyOn(commentRepo, 'listPublicByTicket').mockImplementation(async (ticketId: string) => {
      const result = await originalList(ticketId);
      // Simula el tiempo que tarda la query real — representa la ventana en la
      // que el operador puede responder ANTES de que markMessagesRead corra.
      jest.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
      return result;
    });

    const useCase = new ListPortalTicketMessages(ticketRepo, commentRepo);
    try {
      await useCase.execute('client-a', ticket.sequenceNumber);
    } finally {
      jest.useRealTimers();
    }

    const reloaded = await ticketRepo.getBySequenceNumber(ticket.sequenceNumber);
    // El cursor DEBE quedar en t0 (antes del list), NUNCA en el instante
    // posterior — cualquier mensaje que "aterrice" en esa ventana de 5 minutos
    // tiene que seguir contando como no-leído.
    expect(reloaded!.clientMessagesReadAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('mapea adjuntos de la mensajería nueva (storageKey) y excluye los del sistema viejo (solo url)', async () => {
    const ticketRepo = new InMemoryTicketRepository();
    const commentRepo = new InMemoryTicketCommentRepository();
    const ticket = await ticketRepo.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    await commentRepo.create(makeComment({
      id: 'public-1',
      ticketId: ticket.id,
      visibility: 'public',
      authorKind: 'client',
      attachments: [
        { id: 'att-1', commentId: 'public-1', url: null, storageKey: 'tickets/t1/att-1.jpg', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
        { id: 'att-legacy', commentId: 'public-1', url: 'data:image/png;base64,AAAA', storageKey: null, kind: null, filename: 'legacy.png', mimeType: 'image/png', sizeBytes: 3 },
      ],
    }));

    const useCase = new ListPortalTicketMessages(ticketRepo, commentRepo);
    const result = await useCase.execute('client-a', ticket.sequenceNumber);

    expect(result![0]!.attachments).toHaveLength(1);
    expect(result![0]!.attachments[0]).toMatchObject({ id: 'att-1', kind: 'image', filename: 'foto.jpg' });
    expect(result![0]!.attachments[0]!.url).toContain(`/${ticket.sequenceNumber}/`);
  });
});
