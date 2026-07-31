import { GetTicketMessageAttachmentFile } from '@application/use-cases/GetTicketMessageAttachmentFile';
import { InMemoryTicketCommentRepository } from '@infrastructure/adapters/in-memory/InMemoryTicketCommentRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { TicketMessageAttachmentNotFoundError, TicketMessageStorageUnavailableError } from '@domain/errors/ticketMessage';
import type { FileStorage } from '@domain/ports/FileStorage';
import type { TicketMessageLogger } from '@application/use-cases/ticketMessageAttachments';

describe('GetTicketMessageAttachmentFile — portal-ticket-messaging v2.B (lado admin)', () => {
  it('resuelve el binario de un adjunto (público O interno — el staff ve todo)', async () => {
    const comments = new InMemoryTicketCommentRepository();
    const storage = new InMemoryFileStorage();
    await storage.save({ key: 'tickets/t1/c1/a1.jpg', buffer: Buffer.from('img'), mimeType: 'image/jpeg' });
    await comments.create({
      id: 'c1', ticketId: 't1', authorId: null, authorKind: 'staff', visibility: 'internal',
      authorName: 'Ana', body: 'nota', createdAt: new Date().toISOString(),
      attachments: [{ id: 'a1', commentId: 'c1', url: null, storageKey: 'tickets/t1/c1/a1.jpg', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 3 }],
    });
    const useCase = new GetTicketMessageAttachmentFile(comments, storage);

    const file = await useCase.execute('a1');

    expect(file.buffer.toString()).toBe('img');
    expect(file.mimeType).toBe('image/jpeg');
    expect(file.filename).toBe('foto.jpg');
  });

  it('404 si el adjunto no existe', async () => {
    const comments = new InMemoryTicketCommentRepository();
    const storage = new InMemoryFileStorage();
    const useCase = new GetTicketMessageAttachmentFile(comments, storage);

    await expect(useCase.execute('missing')).rejects.toBeInstanceOf(TicketMessageAttachmentNotFoundError);
  });

  it('404 para un adjunto viejo (sistema data-URI, sin storageKey)', async () => {
    const comments = new InMemoryTicketCommentRepository();
    const storage = new InMemoryFileStorage();
    await comments.create({
      id: 'c1', ticketId: 't1', authorId: null, authorKind: 'staff', visibility: 'internal',
      authorName: 'Ana', body: 'nota', createdAt: new Date().toISOString(),
      attachments: [{ id: 'legacy', commentId: 'c1', url: 'data:image/png;base64,AAAA', storageKey: null, kind: null, filename: 'x.png', mimeType: 'image/png', sizeBytes: 3 }],
    });
    const useCase = new GetTicketMessageAttachmentFile(comments, storage);

    await expect(useCase.execute('legacy')).rejects.toBeInstanceOf(TicketMessageAttachmentNotFoundError);
  });

  it('G10 (fix wave FINAL): MinIO caído en la LECTURA -> 503 TicketMessageStorageUnavailableError (mensaje genérico), no el crudo/500 — revert-probe: sacar el try/catch de fileStorage.get pone este test en rojo', async () => {
    const comments = new InMemoryTicketCommentRepository();
    await comments.create({
      id: 'c1', ticketId: 't1', authorId: null, authorKind: 'staff', visibility: 'internal',
      authorName: 'Ana', body: 'nota', createdAt: new Date().toISOString(),
      attachments: [{ id: 'a1', commentId: 'c1', url: null, storageKey: 'tickets/t1/c1/a1.jpg', kind: 'image', filename: 'foto.jpg', mimeType: 'image/jpeg', sizeBytes: 3 }],
    });
    const warnings: string[] = [];
    const logger: TicketMessageLogger = { warn: (m) => { warnings.push(m); } };
    const brokenStorage: FileStorage = {
      save: jest.fn(async () => {}),
      get: jest.fn(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9000'); }),
      delete: jest.fn(async () => {}),
    };
    const useCase = new GetTicketMessageAttachmentFile(comments, brokenStorage, logger);

    let caught: unknown;
    try {
      await useCase.execute('a1');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TicketMessageStorageUnavailableError);
    expect((caught as Error).message).not.toMatch(/ECONNREFUSED/);
    expect(warnings.some((w) => w.includes('ECONNREFUSED'))).toBe(true);
  });
});
