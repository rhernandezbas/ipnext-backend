import type { ChatMediaDownloadTrigger } from '@domain/ports/ChatMediaDownloadTrigger';
import type { DownloadChatMessageAttachment } from '@application/use-cases/messaging/DownloadChatMessageAttachment';

/**
 * FireAndForgetChatMediaDownloadTrigger (messaging-inbox-v2-media, F1.5 fase A,
 * Tanda 1 · MEDIA-1/2) — infra impl of `ChatMediaDownloadTrigger`. `requestDownload`
 * returns SYNCHRONOUSLY (the caller — `ReceiveChatwootWebhook`/`GetConversation` —
 * never awaits it): the actual `DownloadChatMessageAttachment.execute` runs
 * detached. A rejection is caught here and logged, NEVER left as an unhandled
 * promise rejection — `ChatMediaDownloadScheduler` (MEDIA-3) is the reliability
 * net that eventually retries whatever this fire-and-forget attempt missed.
 */
export class FireAndForgetChatMediaDownloadTrigger implements ChatMediaDownloadTrigger {
  constructor(private readonly downloadUseCase: DownloadChatMessageAttachment) {}

  requestDownload(attachmentId: string): void {
    void this.downloadUseCase.execute(attachmentId).catch((err) => {
      console.error('[messaging] fire-and-forget download failed (ChatMediaDownloadScheduler will retry)', {
        attachmentId,
        error: err,
      });
    });
  }
}
