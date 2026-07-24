import { NocAlert } from '@domain/entities/nocAlert';
import { AlertNotifier } from '@domain/ports/AlertNotifier';

/**
 * FakeAlertNotifier — Fase D (`noc-alert-telegram`) spy, complements `NoOpAlertNotifier`
 * (A4, which always returns `null` from `.notify` — perfect for "dark ingestion"
 * assertions, but can't exercise the "flag ON, Telegram returns a message id"
 * path). This one records every call (same `notifyCalls`/`editAckCalls` shape)
 * AND lets a test configure what `.notify` resolves to via `notifyResult`, so
 * `NotifyAlert`'s "save telegramChatId/telegramMessageId after a successful
 * send" behaviour is testable without any real Telegram/HTTP call.
 */
export class FakeAlertNotifier implements AlertNotifier {
  notifyCalls: NocAlert[] = [];
  editAckCalls: NocAlert[] = [];
  /** Configurable per-test — defaults to a fixed chat/message id (a "successful send"). */
  notifyResult: { chatId: string; messageId: string } | null = { chatId: 'chat-1', messageId: 'msg-1' };

  async notify(alert: NocAlert): Promise<{ chatId: string; messageId: string } | null> {
    this.notifyCalls.push(alert);
    return this.notifyResult;
  }

  async editAck(alert: NocAlert): Promise<void> {
    this.editAckCalls.push(alert);
  }
}
