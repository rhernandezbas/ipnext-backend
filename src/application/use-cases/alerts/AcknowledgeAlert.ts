import { NocAlert } from '@domain/entities/nocAlert';
import { NocAlertRepository } from '@domain/ports/NocAlertRepository';
import { AlertEventPublisher } from '@domain/ports/AlertEventPublisher';
import { AlertNotifier } from '@domain/ports/AlertNotifier';
import { AuditEventRepository } from '@domain/ports/AuditEventRepository';

/** F2 (noc-alerts-config) — which surface the ack came in through. Drives the
 *  structured AuditEvent's metadata (`afterJson.channel`) — the panel route
 *  passes `req.user`-derived `by`; the Telegram webhook passes `telegram:<user>`. */
export type AcknowledgeChannel = 'panel' | 'telegram';

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
 *
 * F2 (noc-alerts-config, lado BE) — STRUCTURED audit of the ack. The generic
 * `auditMutationsMiddleware` (global, infra) only ever wrote a GENERIC row
 * (action=null, entityType=null) for every /api/alerts mutation — not
 * filterable/attributable. `auditRepo` is an OPTIONAL 4th constructor param
 * (same "add a param, keep every existing call-site compiling" pattern as
 * `notifier` before it) — when present, a successful (`changed: true`) ack
 * writes ONE `AuditEvent` directly: `action='alert.acknowledge'`,
 * `entityType='NocAlert'`, `entityId=<alertId>`, `actorLogin=<by>` (the SAME
 * `by` this method already receives — for the Telegram webhook that's
 * `telegram:<user>`, never the generic middleware's `'anonymous'` fallback,
 * because that middleware never sees `req.user` on the M2M webhook route).
 * `channel` (`panel`|`telegram`, 5th param, defaults to `'panel'`) is folded
 * into `afterJson` alongside the actor — the richest single source of truth
 * for "who acked this, from where". Written DIRECTLY via the
 * `AuditEventRepository` port (NOT the `AuditService`/`createRequestAuditService`
 * pair the ONLY other structured-audit call site in the repo uses —
 * `rolePermissions.routes.ts` — because that helper is built from Express
 * req/res and this use-case is intentionally framework-agnostic; hexagonal
 * DIP forbids it depending on Express). The route layer is responsible for
 * suppressing the middleware's generic duplicate (`res.locals.__auditEmitted`
 * for the panel route; the Telegram webhook path is excluded from the
 * middleware entirely — see `auditMutationsMiddleware.ts`).
 *
 * Gated behind the SAME `changed` flag as publish/notify — an idempotent
 * re-ack (already acked, `changed: false`) writes NOTHING (no new fact to
 * audit). A `record()` failure is caught and swallowed — auditing must never
 * break an ack that already persisted+published successfully.
 */
export class AcknowledgeAlert {
  constructor(
    private readonly repo: NocAlertRepository,
    private readonly publisher: AlertEventPublisher,
    private readonly notifier?: AlertNotifier,
    private readonly auditRepo?: AuditEventRepository,
  ) {}

  async execute(
    id: string,
    by: string,
    at: string,
    note?: string,
    channel: AcknowledgeChannel = 'panel',
  ): Promise<NocAlert | null> {
    const result = await this.repo.acknowledge(id, by, at, note);
    if (!result) return null;
    const { alert, changed } = result;

    if (changed) {
      this.publisher.publish({ type: 'acked', alert });

      if (this.auditRepo) {
        try {
          await this.auditRepo.record({
            actorId: null,
            actorLogin: by,
            method: 'POST',
            path: channel === 'telegram' ? '/api/alerts/telegram/webhook' : `/api/alerts/${id}/acknowledge`,
            action: 'alert.acknowledge',
            entityType: 'NocAlert',
            entityId: id,
            beforeJson: null,
            afterJson: { channel, actor: by, ackAt: at, ackNote: note ?? null },
            statusCode: 200,
            errorMessage: null,
            ip: null,
          });
        } catch (err) {
          // Auditing must never break an ack that already persisted+published.
          console.error('[AcknowledgeAlert] structured audit record failed', err);
        }
      }

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
