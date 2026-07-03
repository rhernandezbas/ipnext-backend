import { GrInvoice } from '@domain/entities/gestionReal';
import { InvoiceStatus } from '@domain/entities/billing';

/**
 * Pure GR-invoice → persistable-shape mapping, shared by every ClientMirror
 * adapter (Prisma + in-memory) so status derivation and date parsing behave
 * identically everywhere. Lives in the application layer alongside the other
 * derivation helpers (`mapContractStatus`, `deriveTechnology`) — it depends only
 * on domain types + the Intl global, never on infrastructure.
 */

/**
 * Normalized shape ready to persist as an `Invoice` row. Dates are JS `Date`s
 * pinned to Argentina midnight; `status` is DERIVED (AD-2), not supplied by GR.
 */
export interface MappedGrInvoice {
  grInvoiceId: string;
  number: string;
  grType: string | null;
  currency: string | null;
  amount: number;
  balance: number;
  issueDate: Date | null;
  dueDate: Date | null;
  status: InvoiceStatus;
  pdfUrl: string | null;
  couponPdfUrl: string | null;
  paymentUrl: string | null;
}

/**
 * YYYY-MM-DD for an instant, in Argentina time. Pure — `Intl` uses node's
 * bundled ICU, so it works on alpine without OS tzdata (same rationale as the
 * GR daily-password `isoDate`). Used to compare calendar days TZ-safely.
 */
function arCalendarDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * "DD-MM-YYYY" → a `Date` at Argentina midnight, or null when unparseable.
 *
 * The prod container runs UTC. Building the date from the process TZ would shift
 * the calendar day in the late-night AR window (AD-4). Argentina is UTC-3
 * year-round (no DST since 2009), so AR midnight == 03:00Z on the SAME day —
 * we build that instant explicitly with `Date.UTC(..., 3, ...)`. Storing at AR
 * midnight means formatting the value back in AR yields the original day (no shift).
 */
export function parseGrInvoiceDate(ddmmyyyy: string | null | undefined): Date | null {
  if (!ddmmyyyy) return null;
  const parts = ddmmyyyy.split('-');
  if (parts.length !== 3) return null;
  const [dd, mm, yyyy] = parts;
  if (dd.length !== 2 || mm.length !== 2 || yyyy.length !== 4) return null;
  const d = Number(dd);
  const m = Number(mm);
  const y = Number(yyyy);
  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) return null;
  if (d < 1 || d > 31 || m < 1 || m > 12) return null;
  const dt = new Date(Date.UTC(y, m - 1, d, 3, 0, 0));
  // Reject impossible calendar dates (e.g. "31-02"): JS Date rolls them into the next
  // month, which would silently shift the stored day and the pendiente/vencida boundary.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt;
}

/**
 * AD-2 — derive the local status from GR's saldo + due date, in Argentina time:
 *   saldo <= 0                       → pagada
 *   saldo > 0 && dueDate >= today(AR)→ pendiente
 *   saldo > 0 && dueDate <  today(AR)→ vencida
 * A missing due date with an outstanding balance is treated as pendiente
 * (not-yet-known-overdue). Comparison is by AR calendar day (string compare of
 * YYYY-MM-DD), which is immune to the process timezone.
 */
export function deriveInvoiceStatus(saldo: number, dueDate: Date | null, now: Date): InvoiceStatus {
  if (saldo <= 0) return 'pagada';
  if (!dueDate) return 'pendiente';
  const today = arCalendarDate(now);
  const due = arCalendarDate(dueDate);
  return due >= today ? 'pendiente' : 'vencida';
}

/** Composite GR identity: `"{tipo}-{sucursal}-{numero}"`. */
export function grInvoiceId(inv: GrInvoice): string {
  return `${inv.tipo}-${inv.sucursal}-${inv.numero}`;
}

/** Map one normalized GrInvoice to a persistable Invoice shape (status derived at `now`). */
export function mapGrInvoice(inv: GrInvoice, now: Date): MappedGrInvoice {
  const dueDate = parseGrInvoiceDate(inv.fechaVto);
  return {
    grInvoiceId: grInvoiceId(inv),
    number: inv.numero,
    grType: inv.tipo,
    currency: inv.moneda,
    amount: inv.importe,
    balance: inv.saldo,
    issueDate: parseGrInvoiceDate(inv.fecha),
    dueDate,
    status: deriveInvoiceStatus(inv.saldo, dueDate, now),
    pdfUrl: inv.urlPdf,
    couponPdfUrl: inv.cuponPdf,
    paymentUrl: inv.paymentUrl,
  };
}
