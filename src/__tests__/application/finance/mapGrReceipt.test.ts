import { mapGrReceipt, receiptIdentityHolds } from '@application/use-cases/finance/mapGrReceipt';
import { GrReceipt } from '@domain/entities/gestionReal';

function baseReceipt(overrides: Partial<GrReceipt> = {}): GrReceipt {
  return {
    grReceiptId: 'R1',
    clienteGrId: '100011',
    recaudador: 'mercadopago',
    fechaRecibo: '15-06-2026 10:00:00',
    fechaConfirmacion: '15-06-2026 10:05:00',
    fechaAnulacion: null,
    observaciones: null,
    applications: [
      { grApplicationId: 'A1', tipo: 'FB', sucursal: '00010', numero: '000074035', importe: 1500, fecha: '15-06-2026' },
    ],
    ...overrides,
  };
}

describe('mapGrReceipt', () => {
  it('maps receipt header fields, parsing dates to AR midnight', () => {
    const { receipt } = mapGrReceipt(baseReceipt());
    expect(receipt.grReceiptId).toBe('R1');
    expect(receipt.clientGrId).toBe('100011');
    expect(receipt.recaudador).toBe('mercadopago');
    expect(receipt.fechaRecibo?.toISOString()).toBe('2026-06-15T03:00:00.000Z');
    expect(receipt.fechaConfirmacion?.toISOString()).toBe('2026-06-15T03:00:00.000Z');
    // gr-receipt-annulment (design.md Decision 3.2) — this used to be an
    // UNCONDITIONAL `toBe(false)`: the mapper hardcoded `anulado: false`
    // because a real annulment never reached this far (the parser dropped it
    // upstream). Rewritten: `anulado` is now DERIVED from
    // `isRealAnnulment(fechaAnulacion, grReceiptId)` — the base fixture's
    // `fechaAnulacion: null` still resolves to `false` (no annulment), so this
    // assertion's VALUE is unchanged, but it now exercises the real derivation
    // instead of a hardcoded literal (see the two new tests below for the
    // `true` branch, which the old hardcoded version could never produce).
    expect(receipt.anulado).toBe(false);
  });

  // ── gr-receipt-annulment (design.md Decision 3.2, scenario 1) ──
  describe('anulado is DERIVED from isRealAnnulment, never hardcoded', () => {
    it('a receipt with a real fechaAnulacion maps to anulado: true', () => {
      const r = baseReceipt({ fechaAnulacion: '20-06-2026 12:00:00' });
      const { receipt } = mapGrReceipt(r);
      expect(receipt.anulado).toBe(true);
    });

    it('a receipt whose fechaAnulacion is the GR sentinel string maps to anulado: false', () => {
      const r = baseReceipt({ fechaAnulacion: '00-00-0000 00:00:00' });
      const { receipt } = mapGrReceipt(r);
      expect(receipt.anulado).toBe(false);
    });
  });

  it('maps each application with the composite grInvoiceId, reusing the same identity as Invoice.grInvoiceId', () => {
    const { applications } = mapGrReceipt(baseReceipt());
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      grApplicationId: 'A1',
      receiptId: 'R1',
      grInvoiceId: 'FB-00010-000074035',
      grType: 'FB',
      amount: 1500,
    });
    expect(applications[0]?.appliedDate?.toISOString()).toBe('2026-06-15T03:00:00.000Z');
  });

  it('maps a receipt with 2+ applications into 2+ rows sharing the same receiptId/recaudador', () => {
    const r = baseReceipt({
      applications: [
        { grApplicationId: 'A1', tipo: 'FB', sucursal: '00010', numero: '1', importe: 1000, fecha: '15-06-2026' },
        { grApplicationId: 'A2', tipo: 'FA', sucursal: '00010', numero: '2', importe: 500, fecha: '15-06-2026' },
      ],
    });
    const { applications } = mapGrReceipt(r);
    expect(applications).toHaveLength(2);
    expect(applications.every((a) => a.receiptId === 'R1')).toBe(true);
    expect(applications.map((a) => a.grInvoiceId)).toEqual(['FB-00010-1', 'FA-00010-2']);
  });

  it('handles null date fields without throwing', () => {
    const r = baseReceipt({ fechaRecibo: null, fechaConfirmacion: null });
    const { receipt } = mapGrReceipt(r);
    expect(receipt.fechaRecibo).toBeNull();
    expect(receipt.fechaConfirmacion).toBeNull();
  });

  // ── fix-wave-2 R1 — items (cash) and retenciones (tax certificates) map to
  // their own rows, distinct from aplicaciones (debt cancelled).
  describe('R1: items and retenciones', () => {
    it('maps items to their own rows, keyed by grItemId, amount = cash received', () => {
      const r = baseReceipt({
        items: [{ grItemId: 'R1-item-1', banco: 'BANCO', cajaCuentaId: '1', destino: 'CTA', fecha: '15-06-2026', importe: 1500, moneda: 'PES', numeroTransferencia: '1', tipo: 'transferencia' }],
      });
      const { items } = mapGrReceipt(r);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ grItemId: 'R1-item-1', receiptId: 'R1', amount: 1500, tipo: 'transferencia' });
    });

    it('maps retenciones to their own rows, keyed by grRetencionId, NEVER conflated with items', () => {
      const r = baseReceipt({
        retenciones: [{ grRetencionId: 'R1-ret-1', tipo: 'retgan', importe: 300, fecha: '15-06-2026' }],
      });
      const { retenciones } = mapGrReceipt(r);
      expect(retenciones).toHaveLength(1);
      expect(retenciones[0]).toMatchObject({ grRetencionId: 'R1-ret-1', receiptId: 'R1', amount: 300, tipo: 'retgan' });
    });

    it('a receipt with items/retenciones omitted (legacy fixture) maps to empty arrays, never throws', () => {
      const { items, retenciones } = mapGrReceipt(baseReceipt());
      expect(items).toEqual([]);
      expect(retenciones).toEqual([]);
    });

    it('receiptIdentityHolds is true when SUM(aplicaciones) == SUM(items) + SUM(retenciones)', () => {
      const r = baseReceipt({
        applications: [{ grApplicationId: 'A1', tipo: 'FB', sucursal: '00010', numero: '1', importe: 1000, fecha: '15-06-2026' }],
        items: [{ grItemId: 'I1', banco: null, cajaCuentaId: null, destino: null, fecha: '15-06-2026', importe: 700, moneda: null, numeroTransferencia: null, tipo: null }],
        retenciones: [{ grRetencionId: 'RET1', tipo: 'retgan', importe: 300, fecha: '15-06-2026' }],
      });
      expect(receiptIdentityHolds(mapGrReceipt(r))).toBe(true);
    });

    it('receiptIdentityHolds is true for a receipt with retenciones and NO items (cash is legitimately zero)', () => {
      const r = baseReceipt({
        applications: [{ grApplicationId: 'A1', tipo: 'FB', sucursal: '00010', numero: '1', importe: 20850.6, fecha: '15-06-2026' }],
        items: [],
        retenciones: [{ grRetencionId: 'RET1', tipo: 'retgan', importe: 20850.6, fecha: '15-06-2026' }],
      });
      expect(receiptIdentityHolds(mapGrReceipt(r))).toBe(true);
    });

    it('receiptIdentityHolds is FALSE when the sums genuinely disagree', () => {
      const r = baseReceipt({
        applications: [{ grApplicationId: 'A1', tipo: 'FB', sucursal: '00010', numero: '1', importe: 1000, fecha: '15-06-2026' }],
        items: [{ grItemId: 'I1', banco: null, cajaCuentaId: null, destino: null, fecha: '15-06-2026', importe: 100, moneda: null, numeroTransferencia: null, tipo: null }],
        retenciones: [],
      });
      expect(receiptIdentityHolds(mapGrReceipt(r))).toBe(false);
    });
  });
});
