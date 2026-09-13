/**
 * bootstrapSuricataActionPorts (suricata-bot-autonomous-actions, Phase A,
 * task A.14; Phase D, task D.4; design D7) — composition root for the four
 * autonomous write ports (reply/close/status/note). The ONLY new file in this
 * change that imports `config` + `getSharedSuricataSession`, molde
 * `bootstrapSuricataSync.ts`.
 *
 * Returns `null` for every port when `SURICATA_BASE_URL`/`SURICATA_BROWSER_WS`
 * are unset (same opt-in gate as the sync scheduler and the reply lane) —
 * this bootstrap is a SEPARATE, stricter gate than the four feature flags:
 * even with every flag ON, no port is ever constructed unless the sidecar
 * envs are actually present.
 *
 * Phase D — `note` is now REAL: `PlaywrightSuricataInternalNote` is
 * constructed when the envs ARE set (D3.b, `high` priority, the shared
 * `replyQueueTimeoutMs` budget — no dedicated env var, D9/H.4). `reply` stays
 * permanently `null` here: it is a plain Botpress HTTP adapter with no
 * `SuricataSession`/browser dependency at all (B.7/D3.b's corrected finding),
 * so it is constructed directly in `app.ts`, never through this file. `close`/
 * `status` stay `null` until Phases E/F land their own drivers (blocked on
 * their own D6 selector capture — already done per tasks.md B.3/B.4, but
 * their driver implementation tasks haven't run yet in THIS batch).
 *
 * Molde `bootstrapSuricataSync.ts` — this function calls the registry's
 * setters itself (`suricataActionPortsRegistry.ts`) so any future non-app
 * consumer reads the SAME instances `app.ts` wires, exactly like
 * `setSuricataSyncScheduler` does for the sync scheduler.
 */
import { config } from '../../config';
import { getSharedSuricataSession } from './sharedSuricataSession';
import { PlaywrightSuricataInternalNote } from './PlaywrightSuricataInternalNote';
import {
  setSuricataBotReplyPort,
  setSuricataBotClosePort,
  setSuricataBotStatusPort,
  setSuricataBotNotePort,
} from './suricataActionPortsRegistry';
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
  const { baseUrl, replyQueueTimeoutMs } = config.suricata;
  const session = getSharedSuricataSession();

  if (!session || !baseUrl) {
    console.warn('[suricata-bot-actions] SURICATA_BASE_URL/SURICATA_BROWSER_WS missing -- action ports disabled');
    const empty: SuricataBotActionPorts = { reply: null, close: null, status: null, note: null };
    setSuricataBotReplyPort(empty.reply);
    setSuricataBotClosePort(empty.close);
    setSuricataBotStatusPort(empty.status);
    setSuricataBotNotePort(empty.note);
    return empty;
  }

  // Phase D — the real note driver. close/status stay null until Phases E/F
  // land their own drivers (see this file's header comment).
  const note = new PlaywrightSuricataInternalNote(session, { sessionTimeoutMs: replyQueueTimeoutMs });

  const ports: SuricataBotActionPorts = { reply: null, close: null, status: null, note };
  setSuricataBotReplyPort(ports.reply);
  setSuricataBotClosePort(ports.close);
  setSuricataBotStatusPort(ports.status);
  setSuricataBotNotePort(ports.note);
  return ports;
}
