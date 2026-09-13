/**
 * suricata-bot-autonomous-actions (Phase A, task A.13, design D7) — holder
 * AISLADO de los 4 ports de escritura autónoma, separado de
 * `bootstrapSuricataActionPorts.ts` a propósito: ese archivo importa
 * `config` + `sharedSuricataSession` (validación fail-fast de env vars al
 * import, `process.exit(1)` si falta alguna). `composeSuricataExternalModule.ts`
 * solo necesita LEER los ports ya construidos -- importar
 * `bootstrapSuricataActionPorts.ts` para eso arrastraría esa validación a
 * tests de rutas que nunca setean esos envs (mismo incidente ya documentado
 * en `suricataSyncSchedulerRegistry.ts`, molde verbatim). Solo tipos
 * (`import type`, borrados en compilación) -- cero dependencias en runtime.
 *
 * Los cuatro getters devuelven `null` hasta que las Fases D-G construyan e
 * implementen sus drivers reales (`PlaywrightSuricata{Note,Status,Close}` y
 * el `SuricataReplySession` real de `PlaywrightSuricataReply`).
 */
import type { SuricataReplyPort } from '@domain/ports/SuricataReplyPort';
import type { SuricataTicketClosePort } from '@domain/ports/SuricataTicketClosePort';
import type { SuricataTicketStatusPort } from '@domain/ports/SuricataTicketStatusPort';
import type { SuricataInternalNotePort } from '@domain/ports/SuricataInternalNotePort';

let replyPort: SuricataReplyPort | null = null;
let closePort: SuricataTicketClosePort | null = null;
let statusPort: SuricataTicketStatusPort | null = null;
let notePort: SuricataInternalNotePort | null = null;

export function setSuricataBotReplyPort(port: SuricataReplyPort | null): void {
  replyPort = port;
}

export function getSuricataBotReplyPort(): SuricataReplyPort | null {
  return replyPort;
}

export function setSuricataBotClosePort(port: SuricataTicketClosePort | null): void {
  closePort = port;
}

export function getSuricataBotClosePort(): SuricataTicketClosePort | null {
  return closePort;
}

export function setSuricataBotStatusPort(port: SuricataTicketStatusPort | null): void {
  statusPort = port;
}

export function getSuricataBotStatusPort(): SuricataTicketStatusPort | null {
  return statusPort;
}

export function setSuricataBotNotePort(port: SuricataInternalNotePort | null): void {
  notePort = port;
}

export function getSuricataBotNotePort(): SuricataInternalNotePort | null {
  return notePort;
}
