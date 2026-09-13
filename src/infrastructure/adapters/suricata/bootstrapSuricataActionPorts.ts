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
 * Phase D — `note` is REAL: `PlaywrightSuricataInternalNote` is constructed
 * when the envs ARE set (D3.b, `high` priority, the shared
 * `replyQueueTimeoutMs` budget — no dedicated env var, D9/H.4). `reply` stays
 * permanently `null` here: it is a plain Botpress HTTP adapter with no
 * `SuricataSession`/browser dependency at all (B.7/D3.b's corrected finding),
 * so it is constructed directly in `app.ts`, never through this file.
 *
 * Phase E — `status` is REAL too: `PlaywrightSuricataStatus`, same
 * `high`-priority/`replyQueueTimeoutMs` shape as `note`.
 *
 * Phase F — `close` is now REAL as well: `PlaywrightSuricataClose`, same
 * shape again. `reply` remains the only permanently-`null` slot here (plain
 * HTTP adapter, no `SuricataSession` dependency, wired directly in `app.ts`).
 *
 * Molde `bootstrapSuricataSync.ts` — this function calls the registry's
 * setters itself (`suricataActionPortsRegistry.ts`) so any future non-app
 * consumer reads the SAME instances `app.ts` wires, exactly like
 * `setSuricataSyncScheduler` does for the sync scheduler.
 */
import { config } from '../../config';
import { getSharedSuricataSession } from './sharedSuricataSession';
import { PlaywrightSuricataInternalNote } from './PlaywrightSuricataInternalNote';
import { PlaywrightSuricataStatus } from './PlaywrightSuricataStatus';
import { PlaywrightSuricataClose } from './PlaywrightSuricataClose';
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

  // Phase D/E/F — the real note, status and close drivers (see this file's
  // header comment). `reply` stays permanently null here (plain HTTP
  // adapter, wired directly in `app.ts`).
  const note = new PlaywrightSuricataInternalNote(session, { sessionTimeoutMs: replyQueueTimeoutMs });
  const status = new PlaywrightSuricataStatus(session, { sessionTimeoutMs: replyQueueTimeoutMs });
  const close = new PlaywrightSuricataClose(session, { sessionTimeoutMs: replyQueueTimeoutMs });

  const ports: SuricataBotActionPorts = { reply: null, close, status, note };
  setSuricataBotReplyPort(ports.reply);
  setSuricataBotClosePort(ports.close);
  setSuricataBotStatusPort(ports.status);
  setSuricataBotNotePort(ports.note);
  return ports;
}
