import { financeAnnulmentGuard } from '@application/use-cases/finance/financeAnnulmentGuard';
import { FinanceReceiptAnnulmentGuardError } from '@application/use-cases/finance/financeIngestErrors';
import { FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { MappedGrReceipt } from '@application/use-cases/finance/mapGrReceipt';

/**
 * gr-receipt-annulment (design.md Decision 4) — the systemic guard: computed
 * over the PAGE the caller mapped (one `execute()` = one page, molde already
 * established by delta/backfill), BEFORE any write. Pure, no I/O.
 */
function mapped(n: number, annulledCount: number): MappedGrReceipt[] {
  const rows: MappedGrReceipt[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      receipt: {
        grReceiptId: `R${i}`,
        clientGrId: '1',
        recaudador: null,
        fechaRecibo: null,
        fechaConfirmacion: null,
        anulado: i < annulledCount,
        observaciones: null,
      },
      applications: [],
      items: [],
      retenciones: [],
    });
  }
  return rows;
}

const cfg = { ...FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS, annulmentGuardMaxPct: 5, annulmentGuardMinCount: 5 };

describe('financeAnnulmentGuard', () => {
  it('0/100 annulled does NOT fire', () => {
    expect(() => financeAnnulmentGuard(mapped(100, 0), cfg, 'reconcile')).not.toThrow();
  });

  it('5/100 annulled does NOT fire — the comparison is strictly ">"', () => {
    expect(() => financeAnnulmentGuard(mapped(100, 5), cfg, 'reconcile')).not.toThrow();
  });

  it('6/100 annulled DOES fire', () => {
    expect(() => financeAnnulmentGuard(mapped(100, 6), cfg, 'reconcile')).toThrow(FinanceReceiptAnnulmentGuardError);
  });

  it('3/4 (75%) does NOT fire — the absolute floor (minCount=5) protects a small legitimate batch', () => {
    expect(() => financeAnnulmentGuard(mapped(4, 3), cfg, 'reconcile')).not.toThrow();
  });

  it('total=0 does NOT fire (no division by zero, nothing to guard)', () => {
    expect(() => financeAnnulmentGuard([], cfg, 'reconcile')).not.toThrow();
  });

  it('exactly at minCount AND over the pct threshold DOES fire (6/10 = 60%, minCount=5)', () => {
    expect(() => financeAnnulmentGuard(mapped(10, 6), cfg, 'reconcile')).toThrow(FinanceReceiptAnnulmentGuardError);
  });

  it('below minCount never fires even at 100% (e.g. 4/4, minCount=5)', () => {
    expect(() => financeAnnulmentGuard(mapped(4, 4), cfg, 'reconcile')).not.toThrow();
  });

  it('the thrown error message includes the lane, the counts, and the threshold', () => {
    try {
      financeAnnulmentGuard(mapped(100, 63), cfg, 'reconcile');
      throw new Error('expected financeAnnulmentGuard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FinanceReceiptAnnulmentGuardError);
      expect((err as Error).message).toMatch(/63/);
      expect((err as Error).message).toMatch(/100/);
      expect((err as Error).message).toMatch(/reconcile/);
    }
  });

  it('a recibos anulados presentes but bajo umbral se persistirian con anulado:true (el guard no muta nada, solo decide abortar o no)', () => {
    const rows = mapped(100, 3);
    expect(() => financeAnnulmentGuard(rows, cfg, 'reconcile')).not.toThrow();
    expect(rows.filter((r) => r.receipt.anulado)).toHaveLength(3);
  });
});
