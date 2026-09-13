/**
 * bootstrapSuricataActionPorts (suricata-bot-autonomous-actions, Phase A,
 * task A.14, design D7) — composition root for the four autonomous write
 * ports (reply/close/status/note). The ONLY new file in this change that
 * imports `config` + `getSharedSuricataSession`, molde `bootstrapSuricataSync.ts`.
 *
 * Returns `null` for every port when `SURICATA_BASE_URL`/`SURICATA_BROWSER_WS`
 * are unset (same opt-in gate as the sync scheduler and the reply lane) —
 * this bootstrap is a SEPARATE, stricter gate than the four feature flags:
 * even with every flag ON, no port is ever constructed unless the sidecar
 * envs are actually present.
 *
 * Phase A scope (this task) is the ISOLATION SHELL ONLY: the driver classes
 * (`PlaywrightSuricataClose`/`PlaywrightSuricataStatus`/`PlaywrightSuricataNote`)
 * don't exist yet — they're blocked on Phase B's live selector capture
 * (design D6). This function therefore constructs nothing real yet, even
 * when the envs ARE set; it always returns all four ports `null`. Phases
 * D-G replace each `null` with a real `new PlaywrightSuricata{X}(session, ...)`
 * construction as each driver lands, registering it via
 * `suricataActionPortsRegistry.ts`.
 */
import { config } from '../../config';
import { getSharedSuricataSession } from './sharedSuricataSession';
import type { SuricataReplyPort } from '@domain/ports/SuricataReplyPort';
import type { SuricataTicketClosePort } from '@domain/ports/SuricataTicketClosePort';
import type { SuricataTicketStatusPort } from '@domain/ports/SuricataTicketStatusPort';
import type { SuricataInternalNotePort } from '@domain/ports/SuricataInternalNotePort';

export interface SuricataBotActionPorts {
  reply: SuricataReplyPort | null;
  close: SuricataTicketClosePort | null;
  status: SuricataTicketStatusPort | null;
  note: SuricataInternalNotePort | null;
}

export function bootstrapSuricataActionPorts(): SuricataBotActionPorts {
  const { baseUrl } = config.suricata;
  const session = getSharedSuricataSession();

  if (!session || !baseUrl) {
    console.warn('[suricata-bot-actions] SURICATA_BASE_URL/SURICATA_BROWSER_WS missing -- action ports disabled');
    return { reply: null, close: null, status: null, note: null };
  }

  // Phase A scope: isolation shell only. Driver classes don't exist until
  // Phases D-G land (blocked on Phase B's live selector capture, D6) — see
  // this file's header comment. Nothing is constructed here yet.
  return { reply: null, close: null, status: null, note: null };
}
