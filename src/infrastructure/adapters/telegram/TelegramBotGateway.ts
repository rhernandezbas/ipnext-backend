import { NocAlert } from '@domain/entities/nocAlert';
import { AlertNotifier } from '@domain/ports/AlertNotifier';
import { TelegramGateway } from './TelegramGateway';

/** `ack:<id>` — the ONLY `callback_data` shape the webhook (alerts.routes.ts) parses. */
export function buildAckCallbackData(alertId: string): string {
  return `ack:${alertId}`;
}

function severityEmoji(severity: NocAlert['severity']): string {
  if (severity === 'critical') return '🔴';
  if (severity === 'warning') return '🟡';
  return 'ℹ️';
}

function formatFiringMessage(alert: NocAlert): string {
  const lines = [
    `${severityEmoji(alert.severity)} *${alert.alertname}*`,
    `${alert.entityType}: ${alert.entityName}`,
    alert.message,
  ];
  if (alert.link) lines.push(alert.link);
  return lines.join('\n');
}

function formatAckedMessage(alert: NocAlert): string {
  const base = formatFiringMessage(alert);
  return `${base}\n\n✅ Tomado por ${alert.ackBy ?? 'alguien'}`;
}

/**
 * TelegramBotGateway — Fase D (`noc-alert-telegram`) adapter implementing the
 * domain port `AlertNotifier` (design.md "TelegramBotGateway" in §File Changes;
 * the port's own docstring already names it as the implementor). Talks to
 * Telegram exclusively through the injected `TelegramGateway` — no axios, no
 * `NocAlert`-shape knowledge on that side; this class is the ONLY place that
 * knows how to turn a `NocAlert` into Telegram text + the `ack:<id>` button.
 *
 * Best-effort: ANY failure from the underlying `TelegramGateway` (network,
 * Telegram 4xx/5xx, bad token) is caught and logged here, never re-thrown —
 * Telegram is a notification channel, not the hub's source of truth (design.md
 * "ACK vive SOLO en el hub"). A Telegram outage must never fail `IngestAlert`'s
 * publish fan-out or `AcknowledgeAlert`'s persist, both of which already
 * completed successfully before this gets invoked.
 */
export class TelegramBotGateway implements AlertNotifier {
  constructor(
    private readonly gateway: TelegramGateway,
    private readonly defaultChatId: string,
  ) {}

  async notify(alert: NocAlert): Promise<{ chatId: string; messageId: string } | null> {
    try {
      return await this.gateway.sendMessage(this.defaultChatId, formatFiringMessage(alert), [
        { text: '✋ Lo tomo', callback_data: buildAckCallbackData(alert.id) },
      ]);
    } catch (err) {
      console.error('[TelegramBotGateway] notify falló — best-effort, no bloquea la ingesta', err);
      return null;
    }
  }

  async editAck(alert: NocAlert): Promise<void> {
    if (!alert.telegramChatId || !alert.telegramMessageId) return;
    try {
      await this.gateway.editMessageText(alert.telegramChatId, alert.telegramMessageId, formatAckedMessage(alert));
    } catch (err) {
      console.error('[TelegramBotGateway] editAck falló — best-effort', err);
    }
  }
}
