import { InMemorySyncStateRepository } from '@infrastructure/adapters/in-memory/InMemorySyncStateRepository';
import { GetFinanceSyncStatus } from '@application/use-cases/finance/GetFinanceSyncStatus';

const BACKFILL_ENTITY = 'finance-receipts-backfill';

describe('GetFinanceSyncStatus', () => {
  it('a healthy composite cursor reports cursorYearMonth/cursorPageOffset correctly', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: '2026-03:1300', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 5000 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.backfill.cursorYearMonth).toBe('2026-03');
    expect(status.backfill.cursorPageOffset).toBe(1300);
    expect(status.backfill.done).toBe(false);
  });

  // ── fix-wave-2 LOW (F14 residual) — this only validated `idx === -1`
  // (no `:` at all), NOT the `isValidYearMonth` shape. A truncated cursor
  // that the ingest use cases ALREADY treat as corrupt (and reset) would
  // still report a bogus `cursorYearMonth` here, contradicting their own
  // "sano" reset — /sync/status must agree with what the use cases actually do.
  it('F14 residual: a truncated yearMonth ("2026-0:5", NOT valid) reports cursorYearMonth as unknown (null), never the garbage substring', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: '2026-0:5', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 10 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.backfill.cursorYearMonth).toBeNull();
    expect(status.backfill.cursorPageOffset).toBe(0);
  });

  it('a cursor with no ":" at all still reports cursorYearMonth as unknown (null) — pre-existing F14 behavior, unchanged', async () => {
    const state = new InMemorySyncStateRepository();
    await state.save({ entity: BACKFILL_ENTITY, cursor: 'garbage', lastRunAt: new Date(), lastResult: 'page ok', itemsSynced: 10 });
    const uc = new GetFinanceSyncStatus(state);

    const status = await uc.execute();

    expect(status.backfill.cursorYearMonth).toBeNull();
  });
});
