import { UnfilteredSegmentError } from '@domain/errors/messaging-bulk';

/**
 * messaging-bulk fix wave 2 (FIX-8) — helper puro compartido por
 * `PreviewCampaignSegment` y `CreateCampaign`. Rechaza un segmento SIN criterio
 * real de filtrado, que de otro modo resolvería a TODA la tabla `Client`
 * (`buildSegmentWhere` → `where:{}`) — y el guard `EMPTY_SEGMENT` (0
 * destinatarios) NO lo cazaría. Una campaña masiva SIEMPRE debe declarar a quién
 * apunta.
 *
 * Un segmento está "filtrado" si tiene:
 *  - al menos un `status`, O
 *  - un piso de deuda REAL (`balanceMin > 0`), O
 *  - un techo de deuda REAL (`balanceMax > 0`).
 *
 * `balanceMin: 0` NO cuenta: con la semántica FIX-12 (piso 0 = incluir también
 * los never-synced `balanceDue = null`) equivale a "todos". Sin este matiz, un
 * `{statuses:[], balanceMin:0}` se colaría y volvería a apuntar a toda la base.
 *
 * ── fix wave 3 (FIX-8-edge): `balanceMax <= 0` tampoco cuenta ────────────────
 * Un techo de `0` (o negativo) sin piso real ni statuses resuelve, con FIX-12, a
 * `balanceDue <= 0 OR balanceDue IS NULL` — es decir TODA la base de saldo cero /
 * never-synced (la enorme mayoría de `Client`). Igual de peligroso que el
 * `balanceMin:0` de arriba. Un techo solo es criterio REAL si es `> 0`.
 */
export function assertSegmentIsFiltered(segment: {
  statuses: string[];
  balanceMin?: number;
  balanceMax?: number;
}): void {
  const hasStatuses = segment.statuses.length > 0;
  const hasMeaningfulBalance =
    (segment.balanceMin != null && segment.balanceMin > 0) ||
    (segment.balanceMax != null && segment.balanceMax > 0);

  if (!hasStatuses && !hasMeaningfulBalance) {
    throw new UnfilteredSegmentError();
  }
}
