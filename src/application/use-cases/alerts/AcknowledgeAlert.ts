import { NocAlert } from '@domain/entities/nocAlert';
import { NocAlertRepository } from '@domain/ports/NocAlertRepository';
import { AlertEventPublisher } from '@domain/ports/AlertEventPublisher';
import { AlertNotifier } from '@domain/ports/AlertNotifier';

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
 *
 * Fase D (`noc-alert-telegram`) — ACK BIDIRECCIONAL: whichever channel the ack
 * came from (panel `POST /:id/acknowledge` OR the Telegram webhook — both call
 * THIS SAME use-case, spec.md "same `AcknowledgeAlert`, not a parallel path"),
 * `AlertNotifier.editAck` is invoked when the alert carries
 * `telegramChatId`/`telegramMessageId` (a message DOES exist to edit). `notifier`
 * is OPTIONAL (3rd param) so every pre-Fase-D call site/test (composeAlertsModule
 * before D, the 6 existing 2-arg construction sites) keeps compiling untouched —
 * omitting it is equivalent to "no Telegram wired", same as the SSE `eventBus`
 * always being present. `editAck` fires ONLY on the ack that actually changed
 * state (`wasAlreadyAcked` checked BEFORE calling `repo.acknowledge`, since the
 * repo's own idempotency (F4) makes a second `acknowledge()` call a silent
 * no-op) — spec.md "Double acknowledge is idempotent across channels": a second
 * ack attempt from the OTHER channel must NOT fire a second `editAck` (the
 * message already reads "tomado por X" from the first one).
 */
export class AcknowledgeAlert {
  constructor(
    private readonly repo: NocAlertRepository,
    private readonly publisher: AlertEventPublisher,
    private readonly notifier?: AlertNotifier,
  ) {}

  async execute(id: string, by: string, at: string, note?: string): Promise<NocAlert | null> {
    const before = await this.repo.findById(id);
    const wasAlreadyAcked = before?.acknowledged === true;

    const alert = await this.repo.acknowledge(id, by, at, note);
    if (!alert) return null;

    this.publisher.publish({ type: 'acked', alert });

    if (!wasAlreadyAcked && this.notifier && alert.telegramChatId && alert.telegramMessageId) {
      await this.notifier.editAck(alert);
    }

    return alert;
  }
}
