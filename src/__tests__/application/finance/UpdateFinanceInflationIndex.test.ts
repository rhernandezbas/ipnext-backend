import { UpdateFinanceInflationIndex } from '@application/use-cases/finance/UpdateFinanceInflationIndex';
import { InMemoryFinanceInflationIndexRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceInflationIndexRepository';
import { FinanceValidationError } from '@domain/errors/finance';

describe('UpdateFinanceInflationIndex (tasks 2.30)', () => {
  it('rejects an invalid yearMonth path param, no persist', async () => {
    const repo = new InMemoryFinanceInflationIndexRepository();
    const useCase = new UpdateFinanceInflationIndex(repo);

    await expect(useCase.execute('2026-13', { monthlyRatePct: 4.2, source: 'INDEC' })).rejects.toBeInstanceOf(FinanceValidationError);
    await expect(useCase.execute('not-a-month', { monthlyRatePct: 4.2, source: 'INDEC' })).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.list()).toEqual([]);
  });

  it('rejects a non-numeric monthlyRatePct, no persist', async () => {
    const repo = new InMemoryFinanceInflationIndexRepository();
    const useCase = new UpdateFinanceInflationIndex(repo);

    await expect(useCase.execute('2026-01', { monthlyRatePct: Number.NaN, source: 'INDEC' })).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.list()).toEqual([]);
  });

  it('a valid payload upserts the month', async () => {
    const repo = new InMemoryFinanceInflationIndexRepository();
    const useCase = new UpdateFinanceInflationIndex(repo);

    const result = await useCase.execute('2026-01', { monthlyRatePct: 4.2, source: 'INDEC' });

    expect(result).toMatchObject({ yearMonth: '2026-01', monthlyRatePct: 4.2, source: 'INDEC' });
  });

  it('source is optional (defaults to null)', async () => {
    const repo = new InMemoryFinanceInflationIndexRepository();
    const useCase = new UpdateFinanceInflationIndex(repo);

    const result = await useCase.execute('2026-01', { monthlyRatePct: 4.2 });

    expect(result.source).toBeNull();
  });

  // ── fix-wave-1 A (converged, both reviewers) — the realistic trigger: an
  // operator pastes the INDEC INDEX (or the annual accumulated rate) instead
  // of the MONTHLY rate. `Decimal(6,3)` can't hold it (max magnitude 999.999)
  // — before this fix, this reached `repo.upsert` and, against real Postgres,
  // raised a raw numeric-overflow error that `errorHandler` couldn't map to a
  // DomainError, surfacing as an opaque 500 instead of a 400.
  it('A: rejects monthlyRatePct beyond Decimal(6,3) magnitude (e.g. the INDEC index instead of the monthly rate), no persist', async () => {
    const repo = new InMemoryFinanceInflationIndexRepository();
    const useCase = new UpdateFinanceInflationIndex(repo);

    await expect(useCase.execute('2026-01', { monthlyRatePct: 42000, source: 'INDEC' })).rejects.toBeInstanceOf(FinanceValidationError);
    await expect(useCase.execute('2026-01', { monthlyRatePct: 1500, source: 'INDEC' })).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.list()).toEqual([]);
  });

  // ── fix-wave-1 A — silent companion bug: rounds to the column scale (3
  // decimals) explicitly, so the in-memory double and Postgres agree on the
  // observable value for the same input.
  it('A: rounds monthlyRatePct to the column scale (3 decimals) before persisting', async () => {
    const repo = new InMemoryFinanceInflationIndexRepository();
    const useCase = new UpdateFinanceInflationIndex(repo);

    const result = await useCase.execute('2026-01', { monthlyRatePct: 4.2001, source: 'INDEC' });

    expect(result.monthlyRatePct).toBe(4.2);
  });

  // ── fix-wave-4 🟡12 — `monthlyRatePct <= -100` breaks `buildChainedIndex`'s
  // multiplicative math downstream: `-100` gives `chainedIndex = 0` (division
  // by zero → `mrrFinalRealArs: Infinity`, which only "survives" as `null` on
  // the wire because `JSON.stringify(Infinity) === "null"` — the DTO's
  // `number | null` type is a LIE at runtime for any consumer that isn't
  // `res.json`, e.g. a future CSV export). `-150` gives a NEGATIVE chained
  // index, silently flipping the sign of every deflated figure. Neither value
  // is economically meaningful (a >= 100% single-month DEFLATION does not
  // happen) — rejected outright, same as the existing magnitude guard.
  it('B: rejects monthlyRatePct <= -100 (breaks the chained-index math downstream), no persist', async () => {
    const repo = new InMemoryFinanceInflationIndexRepository();
    const useCase = new UpdateFinanceInflationIndex(repo);

    await expect(useCase.execute('2026-01', { monthlyRatePct: -100, source: 'INDEC' })).rejects.toBeInstanceOf(FinanceValidationError);
    await expect(useCase.execute('2026-01', { monthlyRatePct: -150, source: 'INDEC' })).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.list()).toEqual([]);
  });

  it('B: a rate strictly greater than -100 is still accepted', async () => {
    const repo = new InMemoryFinanceInflationIndexRepository();
    const useCase = new UpdateFinanceInflationIndex(repo);

    const result = await useCase.execute('2026-01', { monthlyRatePct: -99.9, source: 'INDEC' });

    expect(result.monthlyRatePct).toBe(-99.9);
  });
});
