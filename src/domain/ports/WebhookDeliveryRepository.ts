/**
 * messaging-inbox (F1) — dedup ledger for `X-Chatwoot-Delivery` (HOOK-3, design §2).
 * Separate from `ChatMessageRepository` because `conversation_created`/
 * `conversation_status_changed` deliveries never produce a `ChatMessage` row
 * to hang idempotency off of.
 */
export interface WebhookDeliveryRepository {
  /**
   * Read-only dedup check — does NOT record anything. Used by the caller
   * BEFORE processing (process-then-record, ROB-2): a `true` here means
   * ack with 200 and skip processing, no mirror writes, no re-recording.
   */
  hasSeen(source: string, deliveryId: string): Promise<boolean>;

  /**
   * Records `(source, deliveryId)` as processed. Call ONLY AFTER the event
   * handler completes successfully (process-then-record, ROB-2) — recording
   * BEFORE processing risks losing events: if the handler throws, the
   * delivery would already read as "seen" and Chatwoot's retry would be
   * silently swallowed by `hasSeen`, even though nothing was ever persisted.
   * Returns `true` when it was newly recorded, `false` when it was already
   * recorded (idempotent no-op — never throws on this race). Implementation:
   * `create()` + catch unique-violation race → `false` (same "unique + catch
   * carrera" pattern as `sourceContractId` in `OwnershipTransferCase`).
   */
  recordIfNew(source: string, deliveryId: string): Promise<boolean>;
}
