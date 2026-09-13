/**
 * suricata-bot-autonomous-actions (Phase D) — CONSERVATIVE GUARD, molde
 * `UnavailableSuricataReplyPort.ts`. `bootstrapSuricataActionPorts.ts` wires
 * THIS class as the `SuricataInternalNotePort` fallback whenever
 * `SURICATA_BASE_URL`/`SURICATA_BROWSER_WS` are unset — the same opt-in gate
 * `bootstrapSuricataSync.ts` uses for the sync scheduler. This is a SEPARATE,
 * stricter gate than the `suricata-bot-note-enabled` feature flag (dark by
 * default): even with the flag flipped ON, this capability physically cannot
 * touch a real Suricata session unless the sidecar envs are actually present.
 *
 * Reuses `SuricataAuthError` (`SURICATA_UNAVAILABLE`, 502) rather than a new
 * error class — design D3.c adds exactly two new domain errors
 * (`SuricataActionNotAppliedError`/`SuricataBotActionFailedError`), neither of
 * which fits "no driver is configured at all"; `SuricataAuthError`'s existing
 * `SURICATA_UNAVAILABLE` code already means "the Suricata side of this
 * capability cannot be reached right now", which is exactly this case.
 */
import type { SuricataInternalNotePort } from '@domain/ports/SuricataInternalNotePort';
import { SuricataAuthError } from '@domain/errors/suricata';

export class UnavailableSuricataInternalNotePort implements SuricataInternalNotePort {
  async addNote(_externalId: string, _note: string): Promise<void> {
    throw new SuricataAuthError(
      'No live Suricata action driver is configured (SURICATA_BASE_URL/SURICATA_BROWSER_WS missing) — refusing to post a note',
    );
  }
}
