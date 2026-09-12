import type { SuricataVerdictRecord } from './suricata';

/**
 * suricata-tickets-mirror (Phase D, task D.2, design D9) — a verdict is
 * `stale` when the ticket's CURRENT `contentHash` no longer matches the hash
 * frozen on the verdict at submission time (i.e. the ticket changed since the
 * bot analyzed it). Pure/derived — never a stored column, and never mutates
 * or hides the verdict (D9: "no se borra ni se oculta, la observación fue
 * válida para ese estado"). Consumed by the Phase F panel/KPI DTO mapper.
 */
export function isSuricataVerdictStale(
  verdict: Pick<SuricataVerdictRecord, 'ticketContentHash'>,
  currentTicketContentHash: string,
): boolean {
  return verdict.ticketContentHash !== currentTicketContentHash;
}
