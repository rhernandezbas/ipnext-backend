import { GrInvoice, GrReceipt } from '@domain/entities/gestionReal';
import { FinancePaymentReceipt } from '@domain/ports/FinancePaymentReceiptRepository';
import { FinanceReceiptApplication } from '@domain/ports/FinanceReceiptApplicationRepository';
import { FinanceReceiptItem } from '@domain/ports/FinanceReceiptItemRepository';
import { FinanceReceiptRetencion } from '@domain/ports/FinanceReceiptRetencionRepository';
import { grInvoiceId, parseGrInvoiceDate } from '@application/use-cases/mapGrInvoice';
import { grDateTimeDatePart, isRealAnnulment } from './financeDates';

export interface MappedGrReceipt {
  receipt: FinancePaymentReceipt;
  /**
   * gr-receipt-annulment fix-wave RF5 — the RAW `fecha_anulacion` string GR
   * sent for this receipt, carried through the mapping UNINTERPRETED. It is
   * the only value that tells a sentinel-format DRIFT (every row carrying the
   * same unparseable string) apart from a legitimate annulment spike (varied,
   * real-looking dates) — the systemic guard prints it in its abort message,
   * and the per-flip log prints it when a mirrored receipt becomes annulled.
   * Never persisted: `anulado` is the derived, persistable decision.
   */
  rawFechaAnulacion: string | null;
  applications: FinanceReceiptApplication[];
  /** fix-wave-2 R1 — CASH actually received; the base of the "cash collected" metric (spec.md). */
  items: FinanceReceiptItem[];
  /** fix-wave-2 R1 — tax-withholding certificates; NEVER cash, exposed as a separate series. */
  retenciones: FinanceReceiptRetencion[];
}

/**
 * Pure GR-receipt → persistable-shape mapping (finance-growth Fase 1). Molde
 * `mapGrInvoice.ts` — reuses `grInvoiceId()`/`parseGrInvoiceDate()` from there
 * so the composite identity and AR date parsing behave IDENTICALLY to the
 * existing `gr-invoices-sync` feature (task 1.15 — never reimplement the AR
 * date parsing).
 *
 * gr-receipt-annulment (design.md Decision 3.2) — `anulado` is DERIVED here
 * from `isRealAnnulment(r.fechaAnulacion, r.grReceiptId)`, not hardcoded. A
 * `GrReceipt` reaching this mapper CAN be voided now: the parser
 * (`GestionRealClient.parseReceiptsResponse`) stopped excluding annulled
 * receipts upstream — the mapper is where the domain decides the flag, the
 * parser only passes the raw date through.
 */
export function mapGrReceipt(r: GrReceipt): MappedGrReceipt {
  const receipt: FinancePaymentReceipt = {
    grReceiptId: r.grReceiptId,
    clientGrId: r.clienteGrId,
    recaudador: r.recaudador,
    fechaRecibo: parseGrInvoiceDate(grDateTimeDatePart(r.fechaRecibo)),
    fechaConfirmacion: parseGrInvoiceDate(grDateTimeDatePart(r.fechaConfirmacion)),
    anulado: isRealAnnulment(r.fechaAnulacion, r.grReceiptId),
    observaciones: r.observaciones,
  };

  const applications: FinanceReceiptApplication[] = r.applications.map((a) => ({
    grApplicationId: a.grApplicationId,
    receiptId: r.grReceiptId,
    grInvoiceId: grInvoiceId({ tipo: a.tipo, sucursal: a.sucursal, numero: a.numero ?? '' } as GrInvoice),
    grType: a.tipo ?? '',
    amount: a.importe,
    appliedDate: parseGrInvoiceDate(a.fecha),
  }));

  // fix-wave-2 R1 — `r.items`/`r.retenciones` are optional on the domain type
  // (backward compat for lightweight test fixtures predating this fix); the
  // REAL parser (`GestionRealClient.parseReceiptsResponse`) always populates
  // them (empty array when GR omits the node), never `undefined`.
  const items: FinanceReceiptItem[] = (r.items ?? []).map((i) => ({
    grItemId: i.grItemId,
    receiptId: r.grReceiptId,
    banco: i.banco,
    cajaCuentaId: i.cajaCuentaId,
    destino: i.destino,
    fecha: parseGrInvoiceDate(i.fecha),
    amount: i.importe,
    moneda: i.moneda,
    numeroTransferencia: i.numeroTransferencia,
    tipo: i.tipo,
  }));

  const retenciones: FinanceReceiptRetencion[] = (r.retenciones ?? []).map((ret) => ({
    grRetencionId: ret.grRetencionId,
    receiptId: r.grReceiptId,
    tipo: ret.tipo,
    amount: ret.importe,
    fecha: parseGrInvoiceDate(ret.fecha),
  }));

  return {
    receipt,
    rawFechaAnulacion: typeof r.fechaAnulacion === 'string' ? r.fechaAnulacion : null,
    applications,
    items,
    retenciones,
  };
}

/**
 * True when `SUM(aplicaciones) == SUM(items) + SUM(retenciones)` for one
 * mapped receipt (fix-wave-2 R1 — ground truth measured EXACTLY across 4.839
 * real June-2026 receipts, 0 mismatches; tolerance below is for float
 * rounding only, not an expected discrepancy). Used as a data-integrity
 * guard by the sync use cases — a mismatch is logged as a WARNING, never
 * silently ignored and never a reason to abort ingestion (GR is an external
 * system; a future edge case breaking this identity must be VISIBLE).
 */
export function receiptIdentityHolds(m: MappedGrReceipt): boolean {
  const sumApplications = m.applications.reduce((sum, a) => sum + a.amount, 0);
  const sumItems = m.items.reduce((sum, i) => sum + i.amount, 0);
  const sumRetenciones = m.retenciones.reduce((sum, r) => sum + r.amount, 0);
  return Math.abs(sumApplications - (sumItems + sumRetenciones)) < 0.01;
}
