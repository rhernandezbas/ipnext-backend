/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · B5.3) — GetChatAttachmentFile
 * (spec MEDIA-5, clon de GetTaskAttachmentFile). Scenarios 18/19/20/21.
 */
import { GetChatAttachmentFile } from '@application/use-cases/messaging/GetChatAttachmentFile';
import { InMemoryChatMessageAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { ChatAttachmentNotFoundError, ChatAttachmentNotReadyError } from '@domain/errors/chatAttachment';

async function seedDownloaded(
  attachments: InMemoryChatMessageAttachmentRepository,
  storage: InMemoryFileStorage,
  opts: { withThumb?: boolean } = {},
) {
  const row = await attachments.upsertByChatwootAttachmentId({
    messageId: 'msg-1',
    chatwootAttachmentId: 1,
    fileType: 'image',
    contentType: 'image/jpeg',
    filename: 'foto.jpg',
    sourceUrl: 'https://x/1.jpg',
  });
  await storage.save({ key: `messaging/conv-1/${row.id}.jpg`, buffer: Buffer.from('ORIGINAL'), mimeType: 'image/jpeg' });
  if (opts.withThumb) {
    await storage.save({ key: `messaging/conv-1/${row.id}-thumb.jpg`, buffer: Buffer.from('THUMB'), mimeType: 'image/jpeg' });
    await attachments.markDownloaded(row.id, {
      storageKey: `messaging/conv-1/${row.id}.jpg`,
      thumbStorageKey: `messaging/conv-1/${row.id}-thumb.jpg`,
    });
  } else {
    await attachments.markDownloaded(row.id, { storageKey: `messaging/conv-1/${row.id}.jpg` });
  }
  return row;
}

describe('GetChatAttachmentFile', () => {
  it('scenario 18 — sirve el original (variant default)', async () => {
    const attachments = new InMemoryChatMessageAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const row = await seedDownloaded(attachments, storage);
    const uc = new GetChatAttachmentFile(attachments, storage);

    const file = await uc.execute({ attachmentId: row.id, variant: 'original' });

    expect(file.buffer.toString()).toBe('ORIGINAL');
    expect(file.mimeType).toBe('image/jpeg');
    expect(file.filename).toBe('foto.jpg');
  });

  it('scenario 19 — sirve el thumb cuando existe thumbStorageKey', async () => {
    const attachments = new InMemoryChatMessageAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const row = await seedDownloaded(attachments, storage, { withThumb: true });
    const uc = new GetChatAttachmentFile(attachments, storage);

    const file = await uc.execute({ attachmentId: row.id, variant: 'thumb' });

    expect(file.buffer.toString()).toBe('THUMB');
  });

  it('scenario 19 — variant=thumb SIN thumbStorageKey cae al original (mismo fallback que ScheduledTaskAttachmentDto)', async () => {
    const attachments = new InMemoryChatMessageAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const row = await seedDownloaded(attachments, storage); // no thumb
    const uc = new GetChatAttachmentFile(attachments, storage);

    const file = await uc.execute({ attachmentId: row.id, variant: 'thumb' });

    expect(file.buffer.toString()).toBe('ORIGINAL');
  });

  it('scenario 20 — status pending → ChatAttachmentNotReadyError (409)', async () => {
    const attachments = new InMemoryChatMessageAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: 'msg-1', chatwootAttachmentId: 2, fileType: 'file', contentType: 'application/pdf',
      sourceUrl: 'https://x/2.pdf',
    });
    const uc = new GetChatAttachmentFile(attachments, storage);

    await expect(uc.execute({ attachmentId: row.id, variant: 'original' })).rejects.toBeInstanceOf(ChatAttachmentNotReadyError);
  });

  it('scenario 20 — status failed → ChatAttachmentNotReadyError (409)', async () => {
    const attachments = new InMemoryChatMessageAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: 'msg-1', chatwootAttachmentId: 3, fileType: 'file', contentType: 'application/pdf',
      sourceUrl: 'https://x/3.pdf',
    });
    await attachments.markFailed(row.id, { error: 'boom' });
    const uc = new GetChatAttachmentFile(attachments, storage);

    await expect(uc.execute({ attachmentId: row.id, variant: 'original' })).rejects.toBeInstanceOf(ChatAttachmentNotReadyError);
  });

  it('scenario 21 — id inexistente → ChatAttachmentNotFoundError (404)', async () => {
    const attachments = new InMemoryChatMessageAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const uc = new GetChatAttachmentFile(attachments, storage);

    await expect(uc.execute({ attachmentId: 'ghost', variant: 'original' })).rejects.toBeInstanceOf(ChatAttachmentNotFoundError);
  });

  it('fix-be #6 (BAJO) — thumbStorageKey seteado pero el objeto YA NO existe en el storage (degradado/borrado) → cae al original, nunca 500', async () => {
    const attachments = new InMemoryChatMessageAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: 'msg-1', chatwootAttachmentId: 5, fileType: 'image', contentType: 'image/jpeg',
      sourceUrl: 'https://x/5.jpg',
    });
    await storage.save({ key: `messaging/conv-1/${row.id}.jpg`, buffer: Buffer.from('ORIGINAL'), mimeType: 'image/jpeg' });
    // markDownloaded CON un thumbStorageKey que nunca se guardó (o fue borrado) del storage.
    await attachments.markDownloaded(row.id, {
      storageKey: `messaging/conv-1/${row.id}.jpg`,
      thumbStorageKey: `messaging/conv-1/${row.id}-thumb.jpg`,
    });
    const uc = new GetChatAttachmentFile(attachments, storage);

    const file = await uc.execute({ attachmentId: row.id, variant: 'thumb' });

    expect(file.buffer.toString()).toBe('ORIGINAL');
  });

  it('filename fallback cuando el adjunto no tiene filename', async () => {
    const attachments = new InMemoryChatMessageAttachmentRepository();
    const storage = new InMemoryFileStorage();
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: 'msg-1', chatwootAttachmentId: 4, fileType: 'image', contentType: 'image/png',
      sourceUrl: 'https://x/4.png',
    });
    await storage.save({ key: `messaging/conv-1/${row.id}.png`, buffer: Buffer.from('X'), mimeType: 'image/png' });
    await attachments.markDownloaded(row.id, { storageKey: `messaging/conv-1/${row.id}.png` });
    const uc = new GetChatAttachmentFile(attachments, storage);

    const file = await uc.execute({ attachmentId: row.id, variant: 'original' });
    expect(file.filename).toBe(`attachment-${row.id}`);
  });
});
