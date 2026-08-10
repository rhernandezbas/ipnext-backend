/**
 * finance-growth Fase 1 — pure date helpers shared by the receipt ingest
 * (backfill + delta lanes). Kept separate from `mapGrReceipt.ts` so the
 * scheduler/use cases can import ONLY what they need without pulling in the
 * GR-shape mapping.
 */

import { FinanceValidationError } from '@domain/errors/finance';

/** GR's null-date centinela — appears wherever a date field is "not set" (fecha_anulacion, fecha_creacion, ...). */
export const GR_NULL_DATE_SENTINEL = '00-00-0000 00:00:00';

/**
 * True when `rawFechaAnulacion` represents a REAL annulment.
 *
 * fix-wave-1 F10: this was originally fail-CLOSED (anything non-empty and not
 * EXACTLY equal to `GR_NULL_DATE_SENTINEL` counted as annulled) — a sentinel
 * variant GR never shows today but could tomorrow ("00-00-0000" without a
 * time, "0000-00-00 00:00:00" reversed field order, a double space before
 * the time) would have silently excluded EVERY receipt matching it. F10
 * flipped the SENTINEL check to be format-agnostic (all-zeros in any
 * width/order/separator → NOT annulled, still the case below) — that part is
 * unchanged.
 *
 * gr-receipt-annulment (design.md Decision 5) rewrites what happens to
 * everything that ISN'T the sentinel, in three layers:
 *
 * 1. **Two accepted date formats**, not one: `DD-MM-YYYY[ HH:MM:SS]` (GR's
 *    native format) AND `YYYY-MM-DD[ HH:MM:SS]` (ISO — the plausible drift).
 *    Disambiguated by the FIRST component's width: 4 digits → ISO (year
 *    first), otherwise DD-MM-YYYY.
 * 2. **Residue → annulled** (flips F10's fail-open residual to fail-CLOSED
 *    PER ROW): a value that is non-empty, non-sentinel, and unparseable in
 *    EITHER format now counts as a REAL annulment — "GR no llena ese campo
 *    por gusto". This is a per-ROW decision; it does NOT abort the page (see
 *    `financeAnnulmentGuard` for the systemic guard over a WHOLE page/run).
 * 3. A loud `console.warn` fires for every row landing in bucket 2 — the
 *    diagnostic signal that turns a centinela-format-drift incident into a
 *    10-second read (design.md Decision 4's log sample).
 */
export function isRealAnnulment(rawFechaAnulacion: unknown, receiptKeyForLogging?: string): boolean {
  const s = typeof rawFechaAnulacion === 'string' ? rawFechaAnulacion.trim() : '';
  if (s === '') return false;

  const datePart = grDateTimeDatePart(s);
  if (!datePart) {
    warnUnparseableAnnulmentDate(s, receiptKeyForLogging);
    return true;
  }

  const parts = datePart.split(/[-/.]/);
  if (parts.length !== 3) {
    warnUnparseableAnnulmentDate(s, receiptKeyForLogging);
    return true;
  }
  const [p0, p1, p2] = parts.map((p) => Number(p));
  const rawParts = parts as [string, string, string];
  if (![p0, p1, p2].every((n) => Number.isInteger(n))) {
    warnUnparseableAnnulmentDate(s, receiptKeyForLogging);
    return true;
  }

  // All-zeros sentinel, any field order/width — NOT an annulment. Checked
  // BEFORE format disambiguation, exactly as F10 left it: this is the
  // KNOWN-GOOD case, never warned about, regardless of which format it LOOKS
  // like (a bare "0000-00-00 00:00:00" would otherwise misparse as ISO).
  if (p0 === 0 && p1 === 0 && p2 === 0) return false;

  // Format disambiguation: a 4-digit FIRST component means ISO
  // (year-month-day); anything else is GR's native DD-MM-YYYY.
  const isIsoShaped = rawParts[0].length === 4;
  const [dd, mm] = isIsoShaped ? [p2, p1] : [p0, p1];
  if (dd === undefined || mm === undefined || dd < 1 || dd > 31 || mm < 1 || mm > 12) {
    warnUnparseableAnnulmentDate(s, receiptKeyForLogging);
    return true;
  }

  return true;
}

function warnUnparseableAnnulmentDate(raw: string, receiptKeyForLogging?: string): void {
  console.warn(
    `[finance-receipts] fecha_anulacion "${raw}" is non-empty and NOT the all-zeros sentinel, but does NOT parse as a valid DD-MM-YYYY or ISO date${
      receiptKeyForLogging ? ` (receipt ${receiptKeyForLogging})` : ''
    } — tratado como ANULADO (sin dato verificable no se cuenta la plata). If GR changed date formats, revisar YA — the systemic guard may abort the ingest if this becomes widespread.`,
  );
}

/** "DD-MM-YYYY HH:MM:SS" (or "DD-MM-YYYY") → the date-only portion, or null. */
export function grDateTimeDatePart(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.split(' ')[0] ?? null;
}

/** "YYYY-MM" for `d`, in Argentina calendar time. Pure — same ICU approach as `isoDate`/`arCalendarDate`. */
export function arYearMonth(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
  }).format(d);
}

/** `d` → "DD-MM-AAAA" in Argentina calendar time (the format GR's date filters require). */
export function grDateAr(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}-${get('month')}-${get('year')}`;
}

/** "YYYY-MM" → the calendar month immediately BEFORE it (newest→oldest walk). */
export function previousYearMonth(yearMonth: string): string {
  const [yStr, mStr] = yearMonth.split('-');
  let y = Number(yStr);
  let m = Number(mStr) - 1;
  if (m < 1) {
    m = 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * finance-growth Fase 3 — "YYYY-MM" + N (positive or negative) calendar months.
 * Used by `BuildFinanceCohortSnapshot` to compute the 3/6/12-month survival
 * cutoff months from a cohort's alta month, and by the nightly snapshot job to
 * walk a bounded lookback window. `previousYearMonth` stays the single-step
 * newest→oldest primitive the ingest scheduler already depends on; this is
 * the general N-step version, expressed IN TERMS OF it for n<0 so both never
 * diverge on the borrow/carry arithmetic.
 */
export function addMonthsToYearMonth(yearMonth: string, n: number): string {
  if (n === 0) return yearMonth;
  if (n < 0) {
    let result = yearMonth;
    for (let i = 0; i < -n; i++) result = previousYearMonth(result);
    return result;
  }
  const [yStr, mStr] = yearMonth.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const zeroBased = (m - 1) + n;
  const newY = y + Math.floor(zeroBased / 12);
  const newM = (zeroBased % 12) + 1;
  return `${newY}-${String(newM).padStart(2, '0')}`;
}

/** Lexicographic compare of two "YYYY-MM" strings (safe: fixed-width, zero-padded). */
export function compareYearMonth(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * finance-growth Fase 4 fix-wave-4 (🔴4) — `d` + `months` WHOLE calendar
 * months from the REAL instant `d`, clamping the day to the last valid day of
 * the target month (same long→short guard as `IngestGestionRealOrders.
 * monthsBack`, forward + UTC-based here instead of local-time backward — this
 * repo's finance module pins everything to UTC, see `yearMonthToDateRange`).
 *
 * `RankEarlyChurnByVendor`'s "temprano" cutoff used to be computed as
 * `addMonthsToYearMonth(arYearMonth(altaDate), windowMonths)` — floor the
 * alta to its calendar MONTH first, THEN add months, THEN take the 1st of
 * that resulting month as the cutoff. That silently shrinks the window by up
 * to 30 days depending purely on the alta's DAY OF MONTH: an alta on the 31st
 * gets its true 6-month window measured from the 1st, not the 31st — a
 * systematic UNDER-count of early churn that hits hardest on end-of-month
 * altas (exactly the vendors who close deals at month-end). This function
 * measures from the actual alta INSTANT, matching design.md's own wording
 * ("calendar months AFTER THE ALTA", not after the alta's month).
 */
export function addCalendarMonthsToDate(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const targetMonthIndex = d.getUTCMonth() + months;
  const lastDayOfTargetMonth = new Date(Date.UTC(y, targetMonthIndex + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDayOfTargetMonth);
  return new Date(Date.UTC(y, targetMonthIndex, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/**
 * True for a well-formed "YYYY-MM" (4-digit year, month 01-12). Guards
 * against a corrupted/truncated backfill cursor (fix-wave-1 F14) — e.g. a
 * legacy flat "2026-03" cursor misread by `lastIndexOf(':')` arithmetic as
 * yearMonth="2026-0" would otherwise silently build an invalid GR date range
 * and, on GR error, re-persist the SAME corrupt cursor forever.
 */
export function isValidYearMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** True for a well-formed "DD-MM-AAAA" (the GR wire format; fix-wave-1 F14). */
export function isValidGrDate(s: string): boolean {
  return /^(0[1-9]|[12]\d|3[01])-(0[1-9]|1[0-2])-\d{4}$/.test(s);
}

/**
 * "YYYY-MM" → the `[start, endExclusive)` AR-midnight-pinned Date range for
 * that calendar month, matching `parseGrInvoiceDate`'s AR-midnight convention
 * (`Date.UTC(y, m-1, d, 3, 0, 0)`, since Argentina is UTC-3 year-round). Used
 * by the Prisma adapters to filter `appliedDate`/`fechaRecibo` by month
 * without re-deriving the AR-pin logic.
 */
export function yearMonthToDateRange(yearMonth: string): { start: Date; endExclusive: Date } {
  const [yStr, mStr] = yearMonth.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const start = new Date(Date.UTC(y, m - 1, 1, 3, 0, 0));
  const endExclusive = new Date(Date.UTC(y, m, 1, 3, 0, 0));
  return { start, endExclusive };
}

/**
 * finance-growth Fase 4 — every "YYYY-MM" from `from` to `to`, inclusive,
 * ascending. Used by `GetFinanceOverview` to know the FULL calendar range a
 * request covers, independent of which months actually have a
 * `FinanceMonthlySnapshot` row — the difference is `monthsWithoutSnapshot`
 * (a missing snapshot is never silently read as "zero that month").
 */
export function enumerateYearMonths(from: string, to: string): string[] {
  const months: string[] = [];
  let cur = from;
  while (compareYearMonth(cur, to) <= 0) {
    months.push(cur);
    cur = addMonthsToYearMonth(cur, 1);
  }
  return months;
}

/**
 * finance-growth Fase 4 fix-wave-4 (🔵17) — defensive cap against a
 * fat-fingered range (e.g. `1990-01..2026-12`, 444 months) walking every
 * `GET /overview`/`/cohorts`/`/vendors/early-churn`/`/nodes/growth`/
 * `/motivos-baja` request across decades of history with no upper bound.
 * Same 240-month (20-year) generous cap `BackfillFinanceMonthlySnapshots`
 * already established for its own range, applied here to every Fase 4 read
 * endpoint's `[from, to]`. Callers pass an ALREADY-validated `isValidYearMonth`
 * pair (this does not re-validate format) and a `FinanceValidationError`
 * (never a generic `Error`) so a too-wide range comes back as a `400`, not a
 * `500` from the guard use cases wire up per-endpoint.
 */
export const MAX_YEAR_MONTH_RANGE_MONTHS = 240;

export function assertYearMonthRangeWidth(from: string, to: string): void {
  if (enumerateYearMonths(from, to).length > MAX_YEAR_MONTH_RANGE_MONTHS) {
    throw new FinanceValidationError(
      `"from"/"to" abarca más de ${MAX_YEAR_MONTH_RANGE_MONTHS} meses (${MAX_YEAR_MONTH_RANGE_MONTHS / 12} años) — pedí un rango más chico.`,
    );
  }
}

/** "YYYY-MM" → the GR `fecha_desde`/`fecha_hasta` window covering that whole calendar month. */
export function yearMonthToGrRange(yearMonth: string): { fechaDesde: string; fechaHasta: string } {
  const [yStr, mStr] = yearMonth.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of this month
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    fechaDesde: `01-${pad(m)}-${y}`,
    fechaHasta: `${pad(lastDay)}-${pad(m)}-${y}`,
  };
}
