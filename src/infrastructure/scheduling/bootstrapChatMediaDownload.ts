/**
 * bootstrapChatMediaDownload — composition root del scheduler de reintento de
 * `ChatMessageAttachment` (messaging-inbox-v2-media, F1.5 fase A, Tanda 1 · MEDIA-3).
 *
 * Espejo de bootstrapRadiusAuthIngest. Retorna null cuando CHATWOOT_BASE_URL no está
 * configurado (opt-in, mismo criterio que el resto de la integración Chatwoot): el
 * scheduler nunca arranca y no hay nada retriable que valga la pena barrer sin Chatwoot.
 * El ON/OFF real de prod va por el feature flag 'chat-media-download' (dark by default).
 */
import { config } from '../config';
import { HttpChatwootGateway } from '../adapters/chatwoot/HttpChatwootGateway';
import { PrismaChatMessageAttachmentRepository } from '../adapters/prisma/PrismaChatMessageAttachmentRepository';
import { PrismaChatMessageRepository } from '../adapters/prisma/PrismaChatMessageRepository';
import { MinioFileStorage } from '../adapters/minio/MinioFileStorage';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { DownloadChatMessageAttachment } from '@application/use-cases/messaging/DownloadChatMessageAttachment';
import { ChatMediaDownloadScheduler } from './ChatMediaDownloadScheduler';

/**
 * @param intervalMs - Intervalo de tick. Default: `config.chatMediaDownload.intervalMs`
 *   (~2min por default, env-configurable via CHAT_MEDIA_DOWNLOAD_INTERVAL_MS, mínimo 15s).
 * @returns Scheduler listo para .start(), o null si Chatwoot no está configurado.
 */
export async function bootstrapChatMediaDownload(
  intervalMs = config.chatMediaDownload.intervalMs,
): Promise<ChatMediaDownloadScheduler | null> {
  const { baseUrl, accountId, inboxId, apiToken } = config.chatwoot;

  if (!baseUrl) {
    console.warn('[chat-media-download] CHATWOOT_BASE_URL missing -- scheduler disabled');
    return null;
  }

  const gateway = new HttpChatwootGateway({ baseUrl, accountId, inboxId, apiToken });
  const attachmentRepo = new PrismaChatMessageAttachmentRepository();
  const messageRepo = new PrismaChatMessageRepository();
  // Misma instancia MinIO conceptual que task-photos (bucket compartido, prefijo
  // 'messaging/' aísla lógicamente — decisión 1 del proposal). Config opt-in: si
  // MINIO_* falta, el boot NUNCA falla (lazy en MinioFileStorage); cada descarga
  // simplemente termina en StorageNotConfiguredError → markFailed.
  const fileStorage = new MinioFileStorage({
    endPoint: config.minio.endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
    bucket: config.minio.bucket,
  });
  const downloadUseCase = new DownloadChatMessageAttachment(attachmentRepo, messageRepo, gateway, fileStorage);
  const flags = new PrismaFeatureFlagRepository();
  const lock = new PgAdvisoryLock();

  return new ChatMediaDownloadScheduler(attachmentRepo, downloadUseCase, { intervalMs }, lock, flags);
}
