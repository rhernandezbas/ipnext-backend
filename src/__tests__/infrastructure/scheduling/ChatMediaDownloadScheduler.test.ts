/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · B4) — ChatMediaDownloadScheduler,
 * clon EXACTO de `RadiusAuthIngestScheduler` (setInterval+inFlight+DistributedLock+flag).
 * Spec MEDIA-3, scenarios 11/12/13/14/15.
 */
import { ChatMediaDownloadScheduler } from '@infrastructure/scheduling/ChatMediaDownloadScheduler';
import { DownloadChatMessageAttachment } from '@application/use-cases/messaging/DownloadChatMessageAttachment';
import { InMemoryChatMessageAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageAttachmentRepository';
import { InMemoryChatMessageRepository } from '@infrastructure/adapters/in-memory/InMemoryChatMessageRepository';
import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { InMemoryFeatureFlagRepository } from '@infrastructure/adapters/in-memory/InMemoryFeatureFlagRepository';
import { FakeChatwootGateway } from '../../helpers/FakeChatwootGateway';

const FLAG_KEY = 'chat-media-download';
const LOCK_KEY = 'chat-media-download';

async function makeHarness(flagEnabled = true) {
  const attachments = new InMemoryChatMessageAttachmentRepository();
  const messages = new InMemoryChatMessageRepository();
  const storage = new InMemoryFileStorage();
  const gateway = new FakeChatwootGateway();
  const downloadUseCase = new DownloadChatMessageAttachment(attachments, messages, gateway, storage);
  const lock = new InMemoryDistributedLock();
  const flags = new InMemoryFeatureFlagRepository();
  flags.seed(FLAG_KEY, flagEnabled);
  const scheduler = new ChatMediaDownloadScheduler(attachments, downloadUseCase, { intervalMs: 1000, silent: true }, lock, flags);

  const message = await messages.upsertByChatwootMessageId({
    conversationId: 'conv-1',
    chatwootMessageId: 700,
    direction: 'inbound',
    content: '',
    chatwootCreatedAt: new Date().toISOString(),
  });

  return { attachments, messages, storage, gateway, downloadUseCase, lock, flags, scheduler, message };
}

describe('ChatMediaDownloadScheduler', () => {
  it('scenario 14 — dark-by-default: flag OFF -> no barre, returns skipped', async () => {
    const { scheduler, downloadUseCase } = await makeHarness(false);
    const spy = jest.spyOn(downloadUseCase, 'execute');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('scenario 11 — recupera una fila pending que nunca se disparó (proceso reiniciado)', async () => {
    const { attachments, gateway, scheduler, message } = await makeHarness(true);
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id,
      chatwootAttachmentId: 1,
      fileType: 'image',
      contentType: 'image/jpeg',
      sourceUrl: 'https://chat.ipnext.com.ar/x/1.jpg',
    });
    gateway.downloadsByUrl.set('https://chat.ipnext.com.ar/x/1.jpg', { buffer: Buffer.from('IMG'), contentType: 'image/jpeg' });

    const summary = await scheduler.runOnce();

    expect(summary.skipped).toBeUndefined();
    const updated = await attachments.findById(row.id);
    expect(updated!.status).toBe('downloaded');
  });

  it('scenario 12 — reintenta una fila failed con downloadAttempts < 5', async () => {
    const { attachments, gateway, scheduler, message } = await makeHarness(true);
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id,
      chatwootAttachmentId: 2,
      fileType: 'file',
      contentType: 'application/pdf',
      sourceUrl: 'https://chat.ipnext.com.ar/x/2.pdf',
    });
    await attachments.markFailed(row.id, { error: 'timeout' });
    await attachments.markFailed(row.id, { error: 'timeout again' }); // attempts=2
    gateway.downloadsByUrl.set('https://chat.ipnext.com.ar/x/2.pdf', { buffer: Buffer.from('PDF'), contentType: 'application/pdf' });

    await scheduler.runOnce();

    const updated = await attachments.findById(row.id);
    expect(updated!.status).toBe('downloaded');
  });

  it('scenario 13 — downloadAttempts >= 5 queda excluida del barrido (abandono, sin loop infinito)', async () => {
    const { attachments, gateway, downloadUseCase, scheduler, message } = await makeHarness(true);
    const spy = jest.spyOn(downloadUseCase, 'execute');
    const row = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id,
      chatwootAttachmentId: 3,
      fileType: 'file',
      contentType: 'application/pdf',
      sourceUrl: 'https://chat.ipnext.com.ar/x/3.pdf',
    });
    for (let i = 0; i < 5; i++) await attachments.markFailed(row.id, { error: `attempt ${i}` });
    gateway.downloadsByUrl.set('https://chat.ipnext.com.ar/x/3.pdf', { buffer: Buffer.from('PDF'), contentType: 'application/pdf' });

    await scheduler.runOnce();

    expect(spy).not.toHaveBeenCalledWith(row.id);
    const updated = await attachments.findById(row.id);
    expect(updated!.status).toBe('failed'); // unchanged, no 6th attempt
    expect(updated!.downloadAttempts).toBe(5);
  });

  it('scenario 15 — una fila lanza una excepción no controlada; las demás igual se procesan y el scheduler sigue vivo', async () => {
    const { attachments, gateway, downloadUseCase, scheduler, message } = await makeHarness(true);
    const rowA = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id, chatwootAttachmentId: 10, fileType: 'image', contentType: 'image/jpeg',
      sourceUrl: 'https://chat.ipnext.com.ar/x/10.jpg',
    });
    const rowB = await attachments.upsertByChatwootAttachmentId({
      messageId: message.id, chatwootAttachmentId: 11, fileType: 'image', contentType: 'image/jpeg',
      sourceUrl: 'https://chat.ipnext.com.ar/x/11.jpg',
    });
    gateway.downloadsByUrl.set('https://chat.ipnext.com.ar/x/10.jpg', { buffer: Buffer.from('A'), contentType: 'image/jpeg' });
    gateway.downloadsByUrl.set('https://chat.ipnext.com.ar/x/11.jpg', { buffer: Buffer.from('B'), contentType: 'image/jpeg' });

    jest.spyOn(downloadUseCase, 'execute').mockRejectedValueOnce(new Error('boom - uncontrolled'));

    const summary = await scheduler.runOnce();

    expect(summary.skipped).toBeUndefined();
    // one of the two rows threw (mockRejectedValueOnce hits the first call); the OTHER
    // still gets processed to completion — the sweep never stops on the first failure.
    const updatedA = await attachments.findById(rowA.id);
    const updatedB = await attachments.findById(rowB.id);
    const downloadedCount = [updatedA, updatedB].filter((r) => r!.status === 'downloaded').length;
    expect(downloadedCount).toBe(1);

    // scheduler still alive for the next tick — a second run recovers the row that threw.
    const secondSummary = await scheduler.runOnce();
    expect(secondSummary.skipped).toBeUndefined();
  });

  it('lock tomado por otra réplica -> skip', async () => {
    const { scheduler, lock, downloadUseCase } = await makeHarness(true);
    lock.forceAcquireFails = true;
    const spy = jest.spyOn(downloadUseCase, 'execute');
    const summary = await scheduler.runOnce();
    expect(spy).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(true);
  });

  it('no corre concurrente: inFlight=true -> skip', async () => {
    const { scheduler } = await makeHarness(true);
    const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    const skipped = [a, b].filter((r) => r.skipped).length;
    expect(skipped).toBe(1);
  });

  it('libera el lock después de cada run', async () => {
    const { scheduler, lock } = await makeHarness(true);
    const releaseSpy = jest.spyOn(lock, 'release');
    await scheduler.runOnce();
    expect(releaseSpy).toHaveBeenCalledWith(LOCK_KEY);
    expect(lock.heldKeys.has(LOCK_KEY)).toBe(false);
  });

  it('sin filas retriable -> corre sin tirar (barrido vacío)', async () => {
    const { scheduler } = await makeHarness(true);
    const summary = await scheduler.runOnce();
    expect(summary.skipped).toBeUndefined();
  });
});
