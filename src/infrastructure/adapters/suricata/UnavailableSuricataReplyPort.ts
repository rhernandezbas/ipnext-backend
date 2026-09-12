/**
 * suricata-tickets-mirror (Phase E) — CONSERVATIVE GUARD added by this apply
 * session, on top of what design.md/tasks.md literally spell out for this
 * phase. The user's explicit instruction: this phase must NOT be able to
 * write to a real customer today, and if the design leaves that ambiguous,
 * add the guard and document it — this file (plus the reused
 * `SURICATA_UNAVAILABLE` code, see `SuricataReplyDriverUnavailableError`) is
 * that guard.
 *
 * `composeSuricataModule.ts` wires THIS class UNCONDITIONALLY as the
 * `SuricataReplyPort` for `ReplyToSuricataTicket` — never `PlaywrightSuricataReply`
 * — because Phase J (`playwright-core`, the sidecar, D5) has not landed:
 * there is no `SuricataReplySession` implementation backed by a real browser
 * anywhere in this codebase yet. Every call fails IMMEDIATELY, before ever
 * touching `SuricataSession`/a lock/a browser — this is independent of and
 * IN ADDITION TO the `suricata-reply-enabled` feature flag (seeded `false`,
 * Phase A migration) and the `suricata.reply` RBAC gate (granted only to
 * `super_admin`/`administrador`, same migration): even if BOTH of those were
 * somehow flipped on today, this port still refuses to send.
 *
 * Phase J replaces the single wiring line in `composeSuricataModule.ts` that
 * constructs this class with the real `PlaywrightSuricataReply` once the
 * sidecar + `SuricataReplySession` driver exist — this file is deleted then,
 * exactly like `bootstrapSuricataSync.ts`'s analogous C.10 guard for the sync
 * lane (same reasoning, same Phase J boundary).
 */
import type { SuricataReplyPort } from '@domain/ports/SuricataReplyPort';
import { SuricataReplyDriverUnavailableError } from '@domain/errors/suricata';

export class UnavailableSuricataReplyPort implements SuricataReplyPort {
  async sendReply(_externalId: string, _body: string): Promise<void> {
    throw new SuricataReplyDriverUnavailableError();
  }
}
