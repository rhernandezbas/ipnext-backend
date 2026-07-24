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
  /**
   * F-D4 (fix wave) — `changed: true` ONLY when THIS call actually flipped
   * the row from unacked→acked (first-ack-wins, F4's idempotency rule). A
   * second/concurrent ack of an already-acked row returns the SAME row with
   * `changed: false`. `AcknowledgeAlert` decides editAck/publish from THIS
   * result, not from a pre-check `findById` — a pre-check racing a
   * concurrent caller can observe stale "not yet acked" state and fire a
   * duplicate side-effect; the repo's own atomic-enough check cannot.
   */
  acknowledge(id: string, by: string, at: string, note?: string): Promise<{ alert: NocAlert; changed: boolean } | null>;
  /**
   * Fase D (`noc-alert-telegram`) — persists the `chatId`/`messageId` returned
   * by `AlertNotifier.notify` right after a successful outbound Telegram send,
   * so a later `editAck` knows WHICH message to edit. `null` if the id doesn't
   * exist (mirrors `acknowledge`'s not-found contract).
   */
  attachTelegramMessage(id: string, chatId: string, messageId: string): Promise<NocAlert | null>;
}
