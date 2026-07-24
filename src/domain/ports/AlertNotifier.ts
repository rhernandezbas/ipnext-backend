import { NocAlert } from '@domain/entities/nocAlert';

/**
 * AlertNotifier — outbound Telegram (Fase D) gateway port. NOT invoked by any
 * Fase A use-case (dark ingestion — see spec.md "Dark ingestion — no outbound
 * side-effects"). Defined now so the port shape is fixed for `TelegramBotGateway`.
 */
export interface AlertNotifier {
  notify(alert: NocAlert): Promise<{ chatId: string; messageId: string } | null>;
  editAck(alert: NocAlert): Promise<void>;
}
