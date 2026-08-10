import { financeAnnulmentGuard } from '@application/use-cases/finance/financeAnnulmentGuard';
import { FinanceReceiptAnnulmentGuardError } from '@application/use-cases/finance/financeIngestErrors';
import { FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS } from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { MappedGrReceipt } from '@application/use-cases/finance/mapGrReceipt';

/**
 * gr-receipt-annulment (design.md Decision 4) — the systemic guard: computed
 * over the PAGE the caller mapped (one `execute()` = one page, molde already
 * established by delta/backfill), BEFORE any write. Pure, no I/O.
 */
function mapped(n: number, annulledCount: number, rawByIndex: (i: number) => string | null = () => 'basura'): MappedGrReceipt[] {
  const rows: MappedGrReceipt[] = [];
  for (let i = 0; i < n; i++) {
    const anulado = i < annulledCount;
    rows.push({
      receipt: {
        grReceiptId: `R${i}`,
        clientGrId: '1',
        recaudador: null,
        fechaRecibo: null,
        fechaConfirmacion: null,
        anulado,
        observaciones: null,
      },
      rawFechaAnulacion: anulado ? rawByIndex(i) : '00-00-0000 00:00:00',
      applications: [],
      items: [],
      retenciones: [],
    });
  }
  return rows;
}

const cfg = { ...FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS, annulmentGuardMaxPct: 5, annulmentGuardMinCount: 5 };
/** The page coordinates every lane passes in (design.md Decision 4's "10-second diagnostic"). */
const ctx = { rango: '06-07-2026..09-08-2026', offset: 0 };

describe('financeAnnulmentGuard', () => {
  it('0/100 annulled does NOT fire', () => {
    expect(() => financeAnnulmentGuard(mapped(100, 0), cfg, 'reconcile', ctx)).not.toThrow();
  });

  it('5/100 annulled does NOT fire — the comparison is strictly ">"', () => {
    expect(() => financeAnnulmentGuard(mapped(100, 5), cfg, 'reconcile', ctx)).not.toThrow();
  });

  it('6/100 annulled DOES fire', () => {
    expect(() => financeAnnulmentGuard(mapped(100, 6), cfg, 'reconcile', ctx)).toThrow(FinanceReceiptAnnulmentGuardError);
  });

  it('3/4 (75%) does NOT fire — the absolute floor (minCount=5) protects a small legitimate batch', () => {
    expect(() => financeAnnulmentGuard(mapped(4, 3), cfg, 'reconcile', ctx)).not.toThrow();
  });

  it('total=0 does NOT fire (no division by zero, nothing to guard)', () => {
    expect(() => financeAnnulmentGuard([], cfg, 'reconcile', ctx)).not.toThrow();
  });

  it('exactly at minCount AND over the pct threshold DOES fire (6/10 = 60%, minCount=5)', () => {
    expect(() => financeAnnulmentGuard(mapped(10, 6), cfg, 'reconcile', ctx)).toThrow(FinanceReceiptAnnulmentGuardError);
  });

  it('below minCount never fires even at 100% (e.g. 4/4, minCount=5)', () => {
    expect(() => financeAnnulmentGuard(mapped(4, 4), cfg, 'reconcile', ctx)).not.toThrow();
  });

  it('the thrown error message includes the lane, the counts, and the threshold', () => {
    try {
      financeAnnulmentGuard(mapped(100, 63), cfg, 'reconcile', ctx);
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
    expect(() => financeAnnulmentGuard(rows, cfg, 'reconcile', ctx)).not.toThrow();
    expect(rows.filter((r) => r.receipt.anulado)).toHaveLength(3);
  });

  // ── fix-wave RF8 — the FLOOR's own frontier. Every pre-existing test around
  // `annulmentGuardMinCount` sits strictly above it (6/10) or strictly below
  // (4/4), so `annulled > minCount` survived the whole suite: the guard would
  // have needed SIX annulments to fire on a page whose floor says five.
  it('annulled EXACTLY at annulmentGuardMinCount fires when the pct is exceeded (5/20 = 25%, minCount=5) — the floor is ">=", not ">"', () => {
    expect(() => financeAnnulmentGuard(mapped(20, 5), cfg, 'reconcile', ctx)).toThrow(FinanceReceiptAnnulmentGuardError);
  });

  it('one BELOW the floor still does not fire at the same ratio (4/16 = 25%) — the floor is what differs, not the pct', () => {
    expect(() => financeAnnulmentGuard(mapped(16, 4), cfg, 'reconcile', ctx)).not.toThrow();
  });

  // ── fix-wave RF5 — design.md Decision 4 asked for the RAW `fecha_anulacion`
  // values in the abort message: identical values across the sample = a GR
  // sentinel-format DRIFT (the mirror is about to be falsely voided); varied
  // real-looking dates = a legitimate ratio spike (raise the knob). The
  // message shipped with grReceiptIds instead — ids the operator cannot
  // diagnose anything from — and NO test looked at the message content at all.
  describe('RF5: the abort message carries the 10-second diagnostic (raw values + rango + offset)', () => {
    it('includes up to 5 samples as id="valor_crudo", plus the range and the offset', () => {
      const rows = mapped(100, 63, () => 'basura');
      try {
        financeAnnulmentGuard(rows, cfg, 'reconcile', { rango: '06-07-2026..09-08-2026', offset: 200 });
        throw new Error('expected financeAnnulmentGuard to throw');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('R0="basura"');
        expect(message).toContain('rango=06-07-2026..09-08-2026');
        expect(message).toContain('offset=200');
        // At most 5 samples — a 63-row sample would be unreadable in a log line.
        expect(message.match(/R\d+="/g)).toHaveLength(5);
      }
    });

    it('a DRIFT (all raw values identical) reads differently from a legitimate spike (varied real dates) — the whole point of showing the raw value', () => {
      const drift = (() => {
        try {
          financeAnnulmentGuard(mapped(100, 63, () => '0000-00-00 00:00:00'), cfg, 'reconcile', ctx);
          return '';
        } catch (err) {
          return (err as Error).message;
        }
      })();
      const spike = (() => {
        try {
          financeAnnulmentGuard(mapped(100, 63, (i) => `0${(i % 9) + 1}-08-2026 10:00:00`), cfg, 'reconcile', ctx);
          return '';
        } catch (err) {
          return (err as Error).message;
        }
      })();

      // Drift: the SAME value five times over.
      expect(drift.match(/"0000-00-00 00:00:00"/g)).toHaveLength(5);
      // Spike: five DIFFERENT values.
      const spikeValues = [...spike.matchAll(/R\d+="([^"]*)"/g)].map((m) => m[1]);
      expect(new Set(spikeValues).size).toBe(5);
    });

    it('a null raw value (annulled by the fail-closed residue with no string at all) is rendered explicitly, never as an empty gap', () => {
      try {
        financeAnnulmentGuard(mapped(100, 63, () => null), cfg, 'reconcile', ctx);
        throw new Error('expected financeAnnulmentGuard to throw');
      } catch (err) {
        expect((err as Error).message).toContain('R0="null"');
      }
    });
  });
});
