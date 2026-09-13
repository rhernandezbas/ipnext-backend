/**
 * suricata-bot-autonomous-actions (Phase A task A.5, CORRECTED 2026-09-13 by
 * live Playwright MCP capture, design D5.a/D6) — the real "Cambiar Estado"
 * status catalog captured from Suricata's `#valorSelect` control.
 *
 * The original design assumed "close is a status transition plus a reason"
 * and this file existed to hold a single `SURICATA_CLOSED_STATUS` literal.
 * That assumption was WRONG: live capture confirmed "Cerrar seleccionados"
 * and "Cambiar Estado" are two independent Suricata actions — the status
 * catalog below has NO closed/cerrado value in it at all. Closing is a
 * separate action (`SuricataTicketClosePort.close`, design D5.a's
 * correction), not a `setStatus` call. There is no closed-status literal to
 * export here anymore.
 *
 * `ChangeSuricataTicketStatus` validates its input status against this
 * allowlist BEFORE it ever reaches the driver — a caller-supplied value that
 * is not one of these 10 is a validation error, never a live click against
 * an unverified/injected string (design D10).
 */
export const SURICATA_STATUS_VALUES = [
  'Open',
  'Progreso',
  'Esperando Respuesta',
  'Nuevo',
  'Llamada Programada',
  'Oferta Rechazada',
  'Oferta Aceptada',
  'Firma Contrato',
  'Ganado',
  'Perdido',
] as const;

export type SuricataStatusValue = (typeof SURICATA_STATUS_VALUES)[number];

export function isSuricataStatusValue(value: string): value is SuricataStatusValue {
  return (SURICATA_STATUS_VALUES as readonly string[]).includes(value);
}
