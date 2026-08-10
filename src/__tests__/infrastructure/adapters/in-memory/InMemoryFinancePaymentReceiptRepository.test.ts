import { InMemoryFinancePaymentReceiptRepository } from '@infrastructure/adapters/in-memory/InMemoryFinancePaymentReceiptRepository';

/**
 * gr-receipt-annulment (design.md Decision 9) — `existingIds` backs the
 * reconcile lane's "nuevos=" observability metric (which of a page's ids the
 * mirror already had BEFORE this sweep persisted it) — a batched Set lookup,
 * never N.
 */
function row(grReceiptId: string, anulado: boolean, recaudador: string | null = null) {
  return { grReceiptId, clientGrId: '1', recaudador, fechaRecibo: null, fechaConfirmacion: null, anulado, observaciones: null };
}

/**
 * gr-receipt-annulment fix-wave RF1 — this double is what EVERY use-case test
 * runs against, so its `upsertBatch` must replicate the REAL Prisma adapter's
 * semantics FIELD BY FIELD, latch included. It used to do a whole-row
 * `rows.set(...)` replacement: strictly more permissive than production, which
 * means the seam tests (S2/S3) were certifying a world Postgres does not run.
 */
describe('InMemoryFinancePaymentReceiptRepository.upsertBatch — same one-way anulado latch as the Prisma adapter', () => {
  it('a NEW row is inserted verbatim, annulled or not', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    await repo.upsertBatch([row('R1', true)]);
    expect(repo.rows.get('R1')?.anulado).toBe(true);
  });

  it('false → true FLIPS (the whole point of the reconcile lane)', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    await repo.upsertBatch([row('R1', false)]);
    await repo.upsertBatch([row('R1', true)]);
    expect(repo.rows.size).toBe(1);
    expect(repo.rows.get('R1')?.anulado).toBe(true);
  });

  it('true → false does NOT flip back — the latch is one-way', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    await repo.upsertBatch([row('R1', true)]);
    await repo.upsertBatch([row('R1', false)]);
    expect(repo.rows.get('R1')?.anulado).toBe(true);
  });

  it('the OTHER fields are still refreshed on an update, even while the latch holds anulado', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    await repo.upsertBatch([row('R1', true, 'mercadopago')]);
    await repo.upsertBatch([row('R1', false, 'rapipago')]);
    expect(repo.rows.get('R1')?.recaudador).toBe('rapipago');
    expect(repo.rows.get('R1')?.anulado).toBe(true);
  });
});

describe('InMemoryFinancePaymentReceiptRepository.annulmentStateOf', () => {
  it('reports the current anulado per EXISTING id, omitting ids with no row yet', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    await repo.upsertBatch([row('R1', false), row('R2', true)]);
    expect(await repo.annulmentStateOf(['R1', 'R2', 'R3'])).toEqual(new Map([['R1', false], ['R2', true]]));
  });

  it('an empty query list returns an empty Map', async () => {
    expect(await new InMemoryFinancePaymentReceiptRepository().annulmentStateOf([])).toEqual(new Map());
  });
});

describe('InMemoryFinancePaymentReceiptRepository.existingIds', () => {
  it('returns only the ids that already exist, as a Set', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    await repo.upsertBatch([
      { grReceiptId: 'R1', clientGrId: '1', recaudador: null, fechaRecibo: null, fechaConfirmacion: null, anulado: false, observaciones: null },
      { grReceiptId: 'R2', clientGrId: '1', recaudador: null, fechaRecibo: null, fechaConfirmacion: null, anulado: false, observaciones: null },
    ]);

    const result = await repo.existingIds(['R1', 'R2', 'R3']);

    expect(result).toEqual(new Set(['R1', 'R2']));
  });

  it('an empty mirror returns an empty Set (no false positives)', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    expect(await repo.existingIds(['R1', 'R2'])).toEqual(new Set());
  });

  it('an empty query list returns an empty Set without throwing', async () => {
    const repo = new InMemoryFinancePaymentReceiptRepository();
    await repo.upsertBatch([{ grReceiptId: 'R1', clientGrId: '1', recaudador: null, fechaRecibo: null, fechaConfirmacion: null, anulado: false, observaciones: null }]);
    expect(await repo.existingIds([])).toEqual(new Set());
  });
});
