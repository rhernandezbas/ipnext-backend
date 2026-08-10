import { deltaCursorHasPendingPages, parseCompositeCursor } from '@application/use-cases/finance/financeReceiptCursors';

/**
 * gr-receipt-annulment (design.md Decision 2) — the composite cursor codec,
 * moved out of `SyncGrReceiptsDelta.ts` so the reconcile lane
 * (`SyncGrReceiptsReconcileWindow`) shares the SAME implementation instead of
 * a second copy. Direct unit coverage here (previously only exercised
 * indirectly through `SyncGrReceiptsDelta.test.ts`).
 */
describe('financeReceiptCursors', () => {
  describe('deltaCursorHasPendingPages', () => {
    it('true for a composite cursor', () => {
      expect(deltaCursorHasPendingPages('10-07-2026:15-07-2026:100')).toBe(true);
    });
    it('false for a plain cursor', () => {
      expect(deltaCursorHasPendingPages('15-07-2026')).toBe(false);
    });
    it('false for null', () => {
      expect(deltaCursorHasPendingPages(null)).toBe(false);
    });
  });

  describe('parseCompositeCursor', () => {
    it('parses a well-formed composite cursor', () => {
      expect(parseCompositeCursor('10-07-2026:15-07-2026:100')).toEqual({
        fechaDesde: '10-07-2026',
        fechaHasta: '15-07-2026',
        offset: 100,
      });
    });
    it('returns null for the wrong number of parts', () => {
      expect(parseCompositeCursor('10-07-2026:15-07-2026')).toBeNull();
    });
    it('returns null when a date is not valid GR format', () => {
      expect(parseCompositeCursor('2026-07-10:15-07-2026:0')).toBeNull();
    });
    it('returns null for a negative offset', () => {
      expect(parseCompositeCursor('10-07-2026:15-07-2026:-5')).toBeNull();
    });
    it('returns null for a non-numeric offset', () => {
      expect(parseCompositeCursor('10-07-2026:15-07-2026:garbage')).toBeNull();
    });
  });
});
