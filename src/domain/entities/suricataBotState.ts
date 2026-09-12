import type { SuricataTicketRecord, SuricataVerdictRecord } from './suricata';
import { isSuricataVerdictStale } from './suricataVerdictStale';

/**
 * suricata-tickets-mirror (Phase F, task F.1, design D13) — the panel's filter
 * bucket for a ticket's bot analysis. Pure/derived, never a stored column
 * (same criterion as `isSuricataVerdictStale`, Phase D):
 *
 *   'sin_analizar'    — no verdict has ever been submitted for this ticket.
 *   'stale'           — a verdict exists, but the ticket changed since (D9):
 *                        its `contentHash` no longer matches the one frozen
 *                        on the verdict. Takes priority over resuelto/no,
 *                        because the observation no longer describes the
 *                        CURRENT ticket — the panel and KPIs treat it as its
 *                        own bucket (D9: "un número que mezcla ambos no
 *                        significa nada").
 *   'resuelto_bot'    — latest verdict is fresh (non-stale) and resuelto=true.
 *   'requiere_humano' — latest verdict is fresh (non-stale) and resuelto=false.
 */
export type SuricataBotState = 'sin_analizar' | 'resuelto_bot' | 'requiere_humano' | 'stale';

export function deriveSuricataBotState(
  ticket: Pick<SuricataTicketRecord, 'contentHash'>,
  latestVerdict: Pick<SuricataVerdictRecord, 'resuelto' | 'ticketContentHash'> | null,
): SuricataBotState {
  if (!latestVerdict) return 'sin_analizar';
  if (isSuricataVerdictStale(latestVerdict, ticket.contentHash)) return 'stale';
  return latestVerdict.resuelto ? 'resuelto_bot' : 'requiere_humano';
}
