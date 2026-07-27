import { UpdateFinanceTargets } from '@application/use-cases/finance/UpdateFinanceTargets';
import { InMemoryFinanceTargetsConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceTargetsConfigRepository';
import { FinanceValidationError } from '@domain/errors/finance';

const validPayload = {
  churnTargetPct: 4,
  maxPaybackMonths: 10,
  monthlyNewContractsGoal: 100,
  inflationBaseYearMonth: '2026-01',
};

describe('UpdateFinanceTargets (tasks 2.23-2.24)', () => {
  it('2.23: rejects churnTargetPct out of 0-100, no partial update', async () => {
    const repo = new InMemoryFinanceTargetsConfigRepository();
    repo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
    const useCase = new UpdateFinanceTargets(repo);

    await expect(useCase.execute({ ...validPayload, churnTargetPct: 101 })).rejects.toBeInstanceOf(FinanceValidationError);
    await expect(useCase.execute({ ...validPayload, churnTargetPct: -1 })).rejects.toBeInstanceOf(FinanceValidationError);

    expect(await repo.get()).toEqual({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
  });

  it('2.23: rejects inflationBaseYearMonth that is neither "" nor YYYY-MM, no partial update', async () => {
    const repo = new InMemoryFinanceTargetsConfigRepository();
    const useCase = new UpdateFinanceTargets(repo);

    await expect(useCase.execute({ ...validPayload, inflationBaseYearMonth: '2026-13' })).rejects.toBeInstanceOf(FinanceValidationError);
    await expect(useCase.execute({ ...validPayload, inflationBaseYearMonth: 'not-a-month' })).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.get()).toMatchObject({ churnTargetPct: 5 }); // untouched, still defaults
  });

  it('2.23: rejects non-integer/negative maxPaybackMonths or monthlyNewContractsGoal', async () => {
    const repo = new InMemoryFinanceTargetsConfigRepository();
    const useCase = new UpdateFinanceTargets(repo);

    await expect(useCase.execute({ ...validPayload, maxPaybackMonths: -1 })).rejects.toBeInstanceOf(FinanceValidationError);
    await expect(useCase.execute({ ...validPayload, maxPaybackMonths: 1.5 })).rejects.toBeInstanceOf(FinanceValidationError);
    await expect(useCase.execute({ ...validPayload, monthlyNewContractsGoal: -1 })).rejects.toBeInstanceOf(FinanceValidationError);
  });

  // ── fix-wave-4 🔵15 — `maxPaybackMonths: 0` used to pass (only `>= 0` was
  // checked). A 0-month "temprano"/payback window is not a real business
  // value — it degenerates `RankEarlyChurnByVendor`'s cutoff to the alta
  // instant itself (an empty window) and `ComputeCacAndPayback`'s lossMaking
  // threshold to "any payback at all is loss-making". Requiring `>= 1` closes
  // that degenerate case at the source instead of in every consumer.
  it('🔵15: rejects maxPaybackMonths: 0 (a 0-month payback window is not a real value), no partial update', async () => {
    const repo = new InMemoryFinanceTargetsConfigRepository();
    repo.seed({ churnTargetPct: 5, maxPaybackMonths: 12, monthlyNewContractsGoal: 0, inflationBaseYearMonth: '' });
    const useCase = new UpdateFinanceTargets(repo);

    await expect(useCase.execute({ ...validPayload, maxPaybackMonths: 0 })).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.get()).toMatchObject({ maxPaybackMonths: 12 }); // untouched
  });

  it('2.24: a full valid payload persists all 4 fields', async () => {
    const repo = new InMemoryFinanceTargetsConfigRepository();
    const useCase = new UpdateFinanceTargets(repo);

    const result = await useCase.execute(validPayload);

    expect(result).toEqual(validPayload);
    expect(await repo.get()).toEqual(validPayload);
  });

  it('accepts inflationBaseYearMonth: "" (un-setting the anchor)', async () => {
    const repo = new InMemoryFinanceTargetsConfigRepository();
    const useCase = new UpdateFinanceTargets(repo);

    const result = await useCase.execute({ ...validPayload, inflationBaseYearMonth: '' });

    expect(result.inflationBaseYearMonth).toBe('');
  });

  // ── fix-wave-1 A (converged, both reviewers) — `maxPaybackMonths`/
  // `monthlyNewContractsGoal` are Postgres 32-bit `Int`. Before this fix,
  // only `Number.isInteger` + `>= 0` were checked — a value beyond INT32_MAX
  // reached `repo.update` and, against real Postgres, raised a raw
  // "integer out of range" error that `errorHandler` can't map to a
  // DomainError, surfacing as an opaque 500 instead of a 400.
  it('A: rejects maxPaybackMonths/monthlyNewContractsGoal beyond the 32-bit INT range, no persist', async () => {
    const repo = new InMemoryFinanceTargetsConfigRepository();
    const useCase = new UpdateFinanceTargets(repo);

    await expect(useCase.execute({ ...validPayload, maxPaybackMonths: 1e10 })).rejects.toBeInstanceOf(FinanceValidationError);
    await expect(useCase.execute({ ...validPayload, monthlyNewContractsGoal: 1e10 })).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.get()).toMatchObject({ churnTargetPct: 5 }); // untouched
  });

  // ── fix-wave-1 A — silent companion bug: rounds churnTargetPct to the
  // column scale (Decimal(5,2), 2 decimals) explicitly, so the in-memory
  // double and Postgres agree on the observable value.
  it('A: rounds churnTargetPct to the column scale (2 decimals) before persisting', async () => {
    const repo = new InMemoryFinanceTargetsConfigRepository();
    const useCase = new UpdateFinanceTargets(repo);

    const result = await useCase.execute({ ...validPayload, churnTargetPct: 5.555 });

    expect(result.churnTargetPct).toBe(5.56);
  });
});
