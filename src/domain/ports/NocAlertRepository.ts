import { NocAlert, NocAlertInput, NocAlertSeverity, NocAlertStatus } from '@domain/entities/nocAlert';

export interface NocAlertListFilters {
  source?: string;
  severity?: NocAlertSeverity;
  status?: NocAlertStatus;
  acknowledged?: boolean;
}

export interface NocAlertRepository {
  /** Dedup by (source, fingerprint) — see `computeNocAlertIngest` for the full rule. */
  upsertByFingerprint(input: NocAlertInput): Promise<NocAlert>;
  findById(id: string): Promise<NocAlert | null>;
  list(filters: NocAlertListFilters): Promise<NocAlert[]>;
  acknowledge(id: string, by: string, at: string, note?: string): Promise<NocAlert | null>;
  /**
   * Fase D (`noc-alert-telegram`) — persists the `chatId`/`messageId` returned
   * by `AlertNotifier.notify` right after a successful outbound Telegram send,
   * so a later `editAck` knows WHICH message to edit. `null` if the id doesn't
   * exist (mirrors `acknowledge`'s not-found contract).
   */
  attachTelegramMessage(id: string, chatId: string, messageId: string): Promise<NocAlert | null>;
}
