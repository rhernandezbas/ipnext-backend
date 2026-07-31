/**
 * portal-ticket-messaging (v2.B) — GetPortalTicketMessageAttachmentFile.
 *
 * spec "Adjunto de un reclamo ajeno": la pertenencia se valida al EMITIR la
 * URL — este test prueba los tres frentes: ticket ajeno, adjunto de OTRO
 * ticket, y adjunto internal (que por invariante nunca debería tener id
 * conocido por el cliente, pero la ruta lo rechaza igual, en capas).
 */
import { GetPortalTicketMessageAttachmentFile } from '@application/use-cases/portal/GetPortalTicketMessageAttachmentFile';
import { InMemoryTicketRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketRepository';
import { InMemoryTicketCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { TicketMessageStorageUnavailableError } from '@domain/errors/ticketMessage';
import type { FileStorage } from '@domain/ports/FileStorage';
import type { TicketMessageLogger } from '@application/use-cases/ticketMessageAttachments';

describe('GetPortalTicketMessageAttachmentFile — customer-portal-api v2.B', () => {
  it('scenario "Cliente manda una foto del módem": adjunto público del PROPIO ticket -> se sirve', async () => {
    const tickets = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    const storage = new InMemoryFileStorage();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    await storage.save({ key: 'tickets/t/c/a1.jpg', buffer: Buffer.from('img'), mimeType: 'image/jpeg' });
    await comments.create({
      id: 'c1', ticketId: ticket.id, authorId: 'acc-1', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'mirá', createdAt: new Date().toISOString(),
      attachments: [{ id: 'a1', commentId: 'c1', url: null, storageKey: 'tickets/t/c/a1.jpg', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 3 }],
    });
    const useCase = new GetPortalTicketMessageAttachmentFile(tickets, comments, storage);

    const file = await useCase.execute('client-a', ticket.sequenceNumber, 'a1');

    expect(file?.buffer.toString()).toBe('img');
  });

  it('scenario "Adjunto de un reclamo ajeno": ticket de otro cliente -> null', async () => {
    const tickets = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    const storage = new InMemoryFileStorage();
    const ticketB = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-b' });
    await comments.create({
      id: 'c1', ticketId: ticketB.id, authorId: 'acc-b', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'mirá', createdAt: new Date().toISOString(),
      attachments: [{ id: 'a1', commentId: 'c1', url: null, storageKey: 'tickets/t/c/a1.jpg', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 3 }],
    });
    const useCase = new GetPortalTicketMessageAttachmentFile(tickets, comments, storage);

    expect(await useCase.execute('client-a', ticketB.sequenceNumber, 'a1')).toBeNull();
  });

  it('adjunto que pertenece a un ticket DISTINTO del pedido -> null (aunque el id exista)', async () => {
    const tickets = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    const storage = new InMemoryFileStorage();
    const ticketA1 = await tickets.create({ subject: 'S1', description: 'D', customerId: 'client-a' });
    const ticketA2 = await tickets.create({ subject: 'S2', description: 'D', customerId: 'client-a' });
    await comments.create({
      id: 'c1', ticketId: ticketA1.id, authorId: 'acc-a', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'mirá', createdAt: new Date().toISOString(),
      attachments: [{ id: 'a1', commentId: 'c1', url: null, storageKey: 'k', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 3 }],
    });
    const useCase = new GetPortalTicketMessageAttachmentFile(tickets, comments, storage);

    // Pide el adjunto a1 (de ticketA1) pero pasando el número de ticketA2.
    expect(await useCase.execute('client-a', ticketA2.sequenceNumber, 'a1')).toBeNull();
  });

  it('adjunto internal (nota interna) del PROPIO ticket -> null (invariante repetido en capas)', async () => {
    const tickets = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    const storage = new InMemoryFileStorage();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    await comments.create({
      id: 'c1', ticketId: ticket.id, authorId: null, authorKind: 'staff', visibility: 'internal',
      authorName: 'Ana', body: 'nota interna con foto', createdAt: new Date().toISOString(),
      attachments: [{ id: 'a1', commentId: 'c1', url: null, storageKey: 'k', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 3 }],
    });
    const useCase = new GetPortalTicketMessageAttachmentFile(tickets, comments, storage);

    expect(await useCase.execute('client-a', ticket.sequenceNumber, 'a1')).toBeNull();
  });

  it('G10 (fix wave FINAL): MinIO caído en la LECTURA -> 503 TicketMessageStorageUnavailableError (mensaje genérico), no el crudo/500 — gemelo del lado admin', async () => {
    const tickets = new InMemoryTicketRepository();
    const comments = new InMemoryTicketCommentRepository();
    const ticket = await tickets.create({ subject: 'S', description: 'D', customerId: 'client-a' });
    await comments.create({
      id: 'c1', ticketId: ticket.id, authorId: 'acc-1', authorKind: 'client', visibility: 'public',
      authorName: 'Cliente', body: 'mirá', createdAt: new Date().toISOString(),
      attachments: [{ id: 'a1', commentId: 'c1', url: null, storageKey: 'tickets/t/c/a1.jpg', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 3 }],
    });
    const warnings: string[] = [];
    const logger: TicketMessageLogger = { warn: (m) => { warnings.push(m); } };
    const brokenStorage: FileStorage = {
      save: jest.fn(async () => {}),
      get: jest.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9000'); }),
      delete: jest.fn(async () => {}),
    };
    const useCase = new GetPortalTicketMessageAttachmentFile(tickets, comments, brokenStorage, logger);

    let caught: unknown;
    try {
      await useCase.execute('client-a', ticket.sequenceNumber, 'a1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TicketMessageStorageUnavailableError);
    expect((caught as Error).message).not.toMatch(/ECONNREFUSED/);
    expect(warnings.some((w) => w.includes('ECONNREFUSED'))).toBe(true);
  });
});
