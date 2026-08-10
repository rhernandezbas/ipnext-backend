import { isValidGrDate } from './financeDates';

/**
 * gr-receipt-annulment (design.md Decision 2) — the composite
 * `"{fechaDesde}:{fechaHasta}:{offset}"` cursor codec, MOVED here from
 * `SyncGrReceiptsDelta.ts` (which re-exports `deltaCursorHasPendingPages` so
 * existing imports keep working unchanged). Previously lived
 * privately/exported inside the delta use case; the reconcile lane
 * (`SyncGrReceiptsReconcileWindow`) needs the EXACT same codec — "una sola
 * implementación del parseo de cursor" (design.md), never a second copy that
 * could quietly drift from the one prod actually runs.
 */

/**
 * True when a persisted composite cursor ("DD-MM-AAAA:DD-MM-AAAA:offset" — a
 * range still has unpaged pages) is present; false for a plain cursor (fully
 * covered) or a missing one.
 */
export function deltaCursorHasPendingPages(cursor: string | null): boolean {
  return !!cursor && cursor.includes(':');
}

/**
 * Parse a composite `"{fechaDesde}:{fechaHasta}:{offset}"` cursor. Returns
 * `null` (never a garbage-filled object) when the shape is wrong or either
 * date isn't a valid GR "DD-MM-AAAA" — fix-wave-1 F14, the caller resets to a
 * known-sane state instead of building a request GR will reject.
 */
export function parseCompositeCursor(cursor: string): { fechaDesde: string; fechaHasta: string; offset: number } | null {
  const parts = cursor.split(':');
  if (parts.length !== 3) return null;
  const [fechaDesde, fechaHasta, offsetStr] = parts as [string, string, string];
  if (!isValidGrDate(fechaDesde) || !isValidGrDate(fechaHasta)) return null;
  const offset = Number(offsetStr);
  if (!Number.isFinite(offset) || offset < 0) return null;
  return { fechaDesde, fechaHasta, offset };
}
