/**
 * PrismaTicketCommentRepository — adapter intention tests with mocked Prisma
 * client (patrón `PrismaOwnershipCaseRepository.where.test.ts` /
 * `PrismaPppoeServiceRepository.listAllWhere.test.ts`).
 *
 * portal-ticket-messaging (v2.B) fix wave, F1 (HIGH): la suite de mensajería
 * (35/35) queda VERDE con el filtro `visibility: 'public'` borrado del WHERE
 * real de `listPublicByTicket` — porque las 5 suites SIEMPRE ejercitan
 * `InMemoryTicketCommentRepository`, nunca este adapter (`rg -l
 * PrismaTicketCommentRepository src/__tests__` daba vacío). El invariante
 * central de la feature ("un internal NUNCA sale por /api/portal/*") no tenía
 * NINGÚN test sobre el código que corre en prod.
 *
 * `listPublicByTicket` es el REVERT-PROBE obligatorio: si alguien borra
 * `visibility: 'public'` del WHERE (o lo mueve a un filtro post-query), el
 * `toEqual` de abajo deja de matchear y este test se pone rojo. Confirmado a
 * mano contra el adapter mutado (ver reporte de la fix wave).
 */
jest.mock('../../infrastructure/database/prisma', () => ({
  prisma: {
    ticketComment: {
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
    ticketCommentAttachment: {
      findUnique: jest.fn(),
    },
  },
}));

import { prisma } from '../../infrastructure/database/prisma';
import { PrismaTicketCommentRepository } from '../../infrastructure/adapters/prisma/PrismaTicketCommentRepository';
import { TicketComment } from '../../domain/entities/ticketComment';

const mockPrisma = prisma as unknown as {
  ticketComment: { findMany: jest.Mock; create: jest.Mock; count: jest.Mock };
  ticketCommentAttachment: { findUnique: jest.Mock };
};

describe('PrismaTicketCommentRepository — listPublicByTicket (F1: INVARIANTE CENTRAL)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.ticketComment.findMany.mockResolvedValue([]);
  });

  it('WHERE incluye visibility:"public" EN LA QUERY (no en un filtro posterior) — revert-probe: borrar esta línea del adapter pone este test en rojo', async () => {
    const repo = new PrismaTicketCommentRepository();
    await repo.listPublicByTicket('ticket-1');

    const call = mockPrisma.ticketComment.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ ticketId: 'ticket-1', visibility: 'public' });
  });

  it('orden cronológico estable: createdAt ASC + id ASC como desempate', async () => {
    const repo = new PrismaTicketCommentRepository();
    await repo.listPublicByTicket('ticket-1');

    const call = mockPrisma.ticketComment.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(call.include).toEqual({ attachments: true });
  });
});

describe('PrismaTicketCommentRepository — listByTicket (admin/staff — TODOS los comentarios)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.ticketComment.findMany.mockResolvedValue([]);
  });

  it('WHERE solo por ticketId — SIN filtro de visibilidad (a propósito: uso admin)', async () => {
    const repo = new PrismaTicketCommentRepository();
    await repo.listByTicket('ticket-1');

    const call = mockPrisma.ticketComment.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ ticketId: 'ticket-1' });
  });
});

describe('PrismaTicketCommentRepository — countUnread (No leídos por lado)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.ticketComment.count.mockResolvedValue(0);
  });

  it('side=client: WHERE visibility:public + authorKind:staff (el cliente solo cuenta público de staff)', async () => {
    const repo = new PrismaTicketCommentRepository();
    await repo.countUnread('ticket-1', 'client', null);

    const call = mockPrisma.ticketComment.count.mock.calls[0][0];
    expect(call.where).toEqual({ ticketId: 'ticket-1', visibility: 'public', authorKind: 'staff' });
  });

  it('side=client con since: agrega createdAt:{gt: since}', async () => {
    const repo = new PrismaTicketCommentRepository();
    const since = new Date('2026-01-01T00:00:00.000Z');
    await repo.countUnread('ticket-1', 'client', since);

    const call = mockPrisma.ticketComment.count.mock.calls[0][0];
    expect(call.where).toEqual({
      ticketId: 'ticket-1',
      visibility: 'public',
      authorKind: 'staff',
      createdAt: { gt: since },
    });
  });

  it('side=staff: WHERE authorKind:client — SIN filtro de visibility (el staff ve TODO lo del cliente)', async () => {
    const repo = new PrismaTicketCommentRepository();
    await repo.countUnread('ticket-1', 'staff', null);

    const call = mockPrisma.ticketComment.count.mock.calls[0][0];
    expect(call.where).toEqual({ ticketId: 'ticket-1', authorKind: 'client' });
  });
});

describe('PrismaTicketCommentRepository — findAttachmentById (autorización de adjuntos)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('findUnique por id, con el comment incluido SOLO para ticketId+visibility (contexto de autorización)', async () => {
    mockPrisma.ticketCommentAttachment.findUnique.mockResolvedValue({
      id: 'att-1',
      commentId: 'c1',
      url: null,
      storageKey: 'tickets/t1/c1/att-1.jpg',
      kind: 'image',
      filename: 'foto.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
      comment: { ticketId: 'ticket-1', visibility: 'public' },
    });
    const repo = new PrismaTicketCommentRepository();

    const result = await repo.findAttachmentById('att-1');

    const call = mockPrisma.ticketCommentAttachment.findUnique.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'att-1' });
    expect(call.include).toEqual({ comment: { select: { ticketId: true, visibility: true } } });
    expect(result).toMatchObject({ id: 'att-1', ticketId: 'ticket-1', visibility: 'public' });
  });

  it('null cuando el adjunto no existe', async () => {
    mockPrisma.ticketCommentAttachment.findUnique.mockResolvedValue(null);
    const repo = new PrismaTicketCommentRepository();

    expect(await repo.findAttachmentById('missing')).toBeNull();
  });
});

describe('PrismaTicketCommentRepository — create', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mapea autoría/visibilidad + adjuntos anidados al create de Prisma', async () => {
    const comment: TicketComment = {
      id: 'c1',
      ticketId: 'ticket-1',
      authorId: 'acc-1',
      authorKind: 'client',
      visibility: 'public',
      authorName: 'Cliente',
      body: 'hola',
      createdAt: '2026-01-01T00:00:00.000Z',
      attachments: [
        { id: 'a1', commentId: 'c1', url: null, storageKey: 'k1', kind: 'image', filename: 'f.jpg', mimeType: 'image/jpeg', sizeBytes: 10 },
      ],
    };
    mockPrisma.ticketComment.create.mockResolvedValue({ ...comment, attachments: comment.attachments });
    const repo = new PrismaTicketCommentRepository();

    await repo.create(comment);

    const call = mockPrisma.ticketComment.create.mock.calls[0][0];
    expect(call.data).toMatchObject({
      id: 'c1',
      ticketId: 'ticket-1',
      authorId: 'acc-1',
      authorKind: 'client',
      visibility: 'public',
    });
    expect(call.data.attachments.create).toHaveLength(1);
    expect(call.include).toEqual({ attachments: true });
  });
});
