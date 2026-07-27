/**
 * finance-growth Fase 1 — pure date helpers shared by the receipt ingest
 * (backfill + delta lanes). Kept separate from `mapGrReceipt.ts` so the
 * scheduler/use cases can import ONLY what they need without pulling in the
 * GR-shape mapping.
 */

/** GR's null-date centinela — appears wherever a date field is "not set" (fecha_anulacion, fecha_creacion, ...). */
export const GR_NULL_DATE_SENTINEL = '00-00-0000 00:00:00';

/**
 * True when `rawFechaAnulacion` represents a REAL annulment.
 *
 * fix-wave-1 F10: this was fail-CLOSED (anything non-empty and not EXACTLY
 * equal to `GR_NULL_DATE_SENTINEL` counted as annulled) — a sentinel variant
 * GR never shows today but could tomorrow ("00-00-0000" without a time,
 * "0000-00-00 00:00:00" reversed field order, a double space before the time)
 * would have silently excluded EVERY receipt matching it (cero ingesta, cero
 * error, cursor avanzando). Flipped to fail-OPEN: only a value that parses as
 * a genuine, non-all-zeros, in-range calendar date counts as a real
 * annulment. Missing/empty/garbage/all-zeros (any width/separator/spacing) →
 * NOT annulled.
 */
/**
 * `receiptKeyForLogging` (fix-wave-2 LOW, F10 residual) — this function is
 * fail-OPEN by design (F10): anything non-empty that DOESN'T parse as a real
 * calendar date is treated as "not annulled", never as a crash or a reason
 * to drop the receipt. The blind spot: fail-open in the direction of "more
 * revenue counted" means a FUTURE format change on GR's side (e.g. switching
 * to ISO `"2026-06-15 10:00:00"` — `dd=2026 > 31` fails the range check)
 * would make every REALLY-annulled receipt matching that shape silently
 * ingest as collected revenue, with F12's empty-page warning never firing
 * (the page still parses non-zero receipts). A cheap WARNING here — logged
 * only for values that are non-empty AND non-all-zeros AND still fail to
 * parse — gives an operator a chance to notice the format drift before it
 * quietly overstates money for however long it takes to notice.
 */
export function isRealAnnulment(rawFechaAnulacion: unknown, receiptKeyForLogging?: string): boolean {
  const s = typeof rawFechaAnulacion === 'string' ? rawFechaAnulacion.trim() : '';
  if (s === '') return false;

  const datePart = grDateTimeDatePart(s);
  if (!datePart) {
    warnUnparseableAnnulmentDate(s, receiptKeyForLogging);
    return false;
  }

  const parts = datePart.split(/[-/.]/);
  if (parts.length !== 3) {
    warnUnparseableAnnulmentDate(s, receiptKeyForLogging);
    return false;
  }
  const [a, b, c] = parts.map((p) => Number(p));
  if (![a, b, c].every((n) => Number.isInteger(n))) {
    warnUnparseableAnnulmentDate(s, receiptKeyForLogging);
    return false;
  }

  // All-zeros sentinel, any field order/width — NOT an annulment. This is
  // the KNOWN-GOOD case, never warned about.
  if (a === 0 && b === 0 && c === 0) return false;

  // A day-month-year triple that isn't even a valid calendar date is not
  // proof of anything either (fail-open: only a REAL date counts).
  const [dd, mm] = [a, b]; // GR's own convention is DD-MM-YYYY.
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) {
    warnUnparseableAnnulmentDate(s, receiptKeyForLogging);
    return false;
  }

  return true;
}

function warnUnparseableAnnulmentDate(raw: string, receiptKeyForLogging?: string): void {
  console.warn(
    `[finance-receipts] fecha_anulacion "${raw}" is non-empty and NOT the all-zeros sentinel, but does NOT parse as a valid DD-MM-YYYY date${
      receiptKeyForLogging ? ` (receipt ${receiptKeyForLogging})` : ''
    } — treated as NOT annulled (fail-open, F10). If GR changed date formats, this may be silently counting a REAL annulment as collected revenue.`,
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
