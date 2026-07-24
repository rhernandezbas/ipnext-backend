import { NocAlert } from '@domain/entities/nocAlert';
import { NocAlertRepository } from '@domain/ports/NocAlertRepository';
import { AlertEventPublisher } from '@domain/ports/AlertEventPublisher';

/**
 * AcknowledgeAlert — sets ackBy/ackAt (and an optional ackNote) on an existing
 * NocAlert. MTTA (ackAt - startsAt) is NOT computed here — spec.md says it's
 * exposed by the DTO (`toNocAlertDto`), so it's derived uniformly for both a
 * fresh ack and any later read (ListAlerts) from the same persisted fields.
 *
 * Non-existent id → does NOT throw; returns null (route maps it to 404), and
 * publishes NOTHING (nothing persisted — same "publish only after a
 * successful persist" rule `IngestAlert` follows).
 *
 * C4 (`noc-alert-realtime`) — publishes `{ type: 'acked', alert }` to the
 * `AlertEventPublisher` port AFTER the repo call resolves to a non-null
 * `NocAlert`, symmetric with `IngestAlert`. This includes the idempotent
 * re-ack case (F4 — repo returns the SAME already-acked row unchanged): the
 * persist call still succeeded, so the panel/Telegram side still gets a fresh
 * "acked" notification for that alert — re-publishing an identical state is
 * harmless (SSE clients just re-render the same DTO), and simpler than
 * threading a "did this call actually change anything" signal back from the
 * repo just to suppress it.
 */
export class AcknowledgeAlert {
  constructor(
    private readonly repo: NocAlertRepository,
    private readonly publisher: AlertEventPublisher,
  ) {}

  async execute(id: string, by: string, at: string, note?: string): Promise<NocAlert | null> {
    const alert = await this.repo.acknowledge(id, by, at, note);
    if (alert) {
      this.publisher.publish({ type: 'acked', alert });
    }
    return alert;
  }
}
