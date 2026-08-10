import {
  FinanceReceiptPostFetchError,
  FinanceReceiptPersistenceError,
  FinanceReceiptAnnulmentGuardError,
} from '@application/use-cases/finance/financeIngestErrors';

/**
 * gr-receipt-annulment (design.md Decision 4) — a marker base class so
 * `FinanceReceiptIngestScheduler.trackGrHealth` can tell "GR answered fine,
 * something AFTER the fetch failed" (persistence OR the systemic guard) apart
 * from a real GR-fetch failure, WITHOUT conflating the guard's abort with a
 * persistence write failure (different failure classes, same non-GR origin).
 */
describe('financeIngestErrors — FinanceReceiptPostFetchError hierarchy', () => {
  it('FinanceReceiptPersistenceError extends FinanceReceiptPostFetchError', () => {
    const err = new FinanceReceiptPersistenceError(new Error('P2000'));
    expect(err).toBeInstanceOf(FinanceReceiptPostFetchError);
  });

  it('FinanceReceiptAnnulmentGuardError extends FinanceReceiptPostFetchError', () => {
    const err = new FinanceReceiptAnnulmentGuardError('ABORT anulados=63/100');
    expect(err).toBeInstanceOf(FinanceReceiptPostFetchError);
  });

  it('a plain Error (e.g. a GR fetch failure) is NOT an instance of FinanceReceiptPostFetchError', () => {
    expect(new Error('GR down')).not.toBeInstanceOf(FinanceReceiptPostFetchError);
  });

  it('FinanceReceiptAnnulmentGuardError is NOT a FinanceReceiptPersistenceError (distinct failure classes)', () => {
    expect(new FinanceReceiptAnnulmentGuardError('x')).not.toBeInstanceOf(FinanceReceiptPersistenceError);
  });

  it('FinanceReceiptPersistenceError.message is unchanged — existing message-matching tests keep working', () => {
    const err = new FinanceReceiptPersistenceError(new Error('P2000: value too long'));
    expect(err.message).toBe('P2000: value too long');
    expect(err.name).toBe('FinanceReceiptPersistenceError');
  });

  it('FinanceReceiptAnnulmentGuardError carries its own message and name', () => {
    const err = new FinanceReceiptAnnulmentGuardError('ABORT anulados=63/100 (63%) umbral=5% min=5');
    expect(err.message).toBe('ABORT anulados=63/100 (63%) umbral=5% min=5');
    expect(err.name).toBe('FinanceReceiptAnnulmentGuardError');
  });
});
