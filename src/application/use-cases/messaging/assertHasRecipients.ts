import { assertSegmentIsFiltered, SegmentCriteria } from './assertSegmentIsFiltered';

/**
 * manual-recipients (MAN-2) — guard para `CreateCampaign`/`PreviewCampaignSegment`/
 * `ListSegmentRecipients` en modo COMBINABLE (segmento + lista manual + CSV +
 * tarea). Una campaña/preview es válido si hay:
 *  - una lista manual NO vacía (target válido por sí solo), O
 *  - `manualContacts` NORMALIZADO no vacío (bulk-csv-recipients, CSV-1 — 3er
 *    componente, mismo criterio que la lista manual: un target válido por sí
 *    solo), O
 *  - `taskStageIds` no vacío (bulk-task-recipients, TASK-1 — 4to componente,
 *    5to dominio "Tarea": un target válido por sí solo), O
 *  - un segmento con criterio real (`assertSegmentIsFiltered`).
 *
 * Se rechaza (con `UnfilteredSegmentError`) SOLO cuando LOS CUATRO están
 * vacíos — evita el `where:{}` = toda la base (FIX-8).
 */
export function assertHasRecipients(
  segment: SegmentCriteria,
  manualClientIds: string[],
  manualContacts: unknown[] = [],
  taskStageIds: string[] = [],
): void {
  if (manualClientIds.length > 0) return;
  if (manualContacts.length > 0) return;
  if (taskStageIds.length > 0) return;
  assertSegmentIsFiltered(segment);
}
