/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · B1.6) — port for the
 * fire-and-forget trigger that kicks off `DownloadChatMessageAttachment` right
 * after a `ChatMessageAttachment` row is created `pending` (spec MEDIA-1/MEDIA-6).
 *
 * `requestDownload` MUST be non-blocking (the caller — `ReceiveChatwootWebhook`/
 * `GetConversation` — never awaits the actual download): the webhook responds 200
 * regardless of how the download turns out. The `ChatMediaDownloadScheduler`
 * (MEDIA-3) is the reliability net that retries anything this trigger missed
 * (process restarted mid-flight, Chatwoot unreachable on the first attempt, ...).
 */
export interface ChatMediaDownloadTrigger {
  requestDownload(attachmentId: string): void;
}
