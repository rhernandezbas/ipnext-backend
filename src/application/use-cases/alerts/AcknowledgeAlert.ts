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
 * always being present.
 *
 * F-D4 (fix wave) — `editAck`/`publish` fire ONLY when `repo.acknowledge`
 * itself reports `changed: true`, NOT from a `before = findById` pre-check.
 * The pre-check version had a real race: two callers (doble-tap del mismo
 * botón, o panel+Telegram casi simultáneos) could BOTH read "not yet acked"
 * before either had persisted, so BOTH fired `editAck`/published `acked` for
 * what was really a single logical ack. Deciding from the repo's own
 * atomic-enough result (F4's idempotency lives THERE, not here) closes that
 * window — spec.md "Double acknowledge is idempotent across channels".
 */
export class AcknowledgeAlert {
  constructor(
    private readonly repo: NocAlertRepository,
    private readonly publisher: AlertEventPublisher,
    private readonly notifier?: AlertNotifier,
  ) {}

  async execute(id: string, by: string, at: string, note?: string): Promise<NocAlert | null> {
    const result = await this.repo.acknowledge(id, by, at, note);
    if (!result) return null;
    const { alert, changed } = result;

    if (changed) {
      this.publisher.publish({ type: 'acked', alert });

      if (this.notifier && alert.telegramChatId && alert.telegramMessageId) {
        try {
          await this.notifier.editAck(alert);
        } catch {
          // F-D5 (fix wave) — best-effort: the ack already persisted and
          // published above; a notifier flake here must not surface as a
          // 500 over state that's already committed.
        }
      }
    }

    return alert;
  }
}
