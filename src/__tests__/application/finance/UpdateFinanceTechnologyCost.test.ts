import { UpdateFinanceTechnologyCost } from '@application/use-cases/finance/UpdateFinanceTechnologyCost';
import { InMemoryFinanceTechnologyCostRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceTechnologyCostRepository';
import { InMemoryContractTechnologyRepository } from '@infrastructure/adapters/in-memory/InMemoryContractTechnologyRepository';
import { FinanceValidationError } from '@domain/errors/finance';
import { FinanceTechnologyNotFoundError } from '@domain/errors/finance';

const validPayload = {
  costoVentaArs: 15000,
  costoInstalacionArs: 20000,
  costoMensualServicioArs: 3000,
  comisionVentaPct: 5,
};

/** Seeds the ContractTechnology catalog with `names` (fix-wave-1 D: existence guard). */
async function catalogWith(...names: string[]): Promise<InMemoryContractTechnologyRepository> {
  const technologies = new InMemoryContractTechnologyRepository();
  for (const name of names) {
    await technologies.create({ name, description: null });
  }
  return technologies;
}

describe('UpdateFinanceTechnologyCost (tasks 2.8-2.10)', () => {
  it('2.8: rejects costoInstalacionArs < 0 without persisting ANY field, even the valid ones in the same payload', async () => {
    const repo = new InMemoryFinanceTechnologyCostRepository();
    repo.seed({
      technologyName: 'Wireless',
      costoVentaArs: 1,
      costoInstalacionArs: 2,
      costoMensualServicioArs: 3,
      comisionVentaPct: 4,
      updatedByUserId: 'old-user',
      updatedAt: new Date('2026-01-01'),
    });
    const useCase = new UpdateFinanceTechnologyCost(repo, await catalogWith('Wireless'));

    await expect(
      useCase.execute('Wireless', { ...validPayload, costoInstalacionArs: -500 }, 'actor-1'),
    ).rejects.toBeInstanceOf(FinanceValidationError);

    const unchanged = await repo.getByTechnology('Wireless');
    expect(unchanged).toMatchObject({
      costoVentaArs: 1,
      costoInstalacionArs: 2,
      costoMensualServicioArs: 3,
      comisionVentaPct: 4,
      updatedByUserId: 'old-user',
    });
  });

  it('2.9: rejects comisionVentaPct > 100', async () => {
    const repo = new InMemoryFinanceTechnologyCostRepository();
    const useCase = new UpdateFinanceTechnologyCost(repo, await catalogWith('Fibra'));

    await expect(
      useCase.execute('Fibra', { ...validPayload, comisionVentaPct: 101 }, 'actor-1'),
    ).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.getByTechnology('Fibra')).toBeNull();
  });

  it('rejects a non-finite/NaN field without persisting', async () => {
    const repo = new InMemoryFinanceTechnologyCostRepository();
    const useCase = new UpdateFinanceTechnologyCost(repo, await catalogWith('Fibra'));

    await expect(
      useCase.execute('Fibra', { ...validPayload, costoVentaArs: Number.NaN }, 'actor-1'),
    ).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.getByTechnology('Fibra')).toBeNull();
  });

  it('2.10: a full valid payload upserts successfully, updatedByUserId set from the actor', async () => {
    const repo = new InMemoryFinanceTechnologyCostRepository();
    const useCase = new UpdateFinanceTechnologyCost(repo, await catalogWith('Fibra'));

    const result = await useCase.execute('Fibra', validPayload, 'actor-42');

    expect(result).toMatchObject({ technologyName: 'Fibra', ...validPayload, updatedByUserId: 'actor-42' });
    const persisted = await repo.getByTechnology('Fibra');
    expect(persisted).toMatchObject({ ...validPayload, updatedByUserId: 'actor-42' });
  });

  // ── fix-wave-1 D — a typo/renamed technologyName upserted a silent orphan
  // (200 OK, never surfaced by GetFinanceTechnologyCosts' catalog-driven LEFT
  // JOIN). Must 404 BEFORE ever touching the repo.
  it('D: rejects a technologyName absent from the ContractTechnology catalog with 404, no persist', async () => {
    const repo = new InMemoryFinanceTechnologyCostRepository();
    const useCase = new UpdateFinanceTechnologyCost(repo, await catalogWith('Fibra')); // "Fibrra" (typo) NOT in catalog

    await expect(useCase.execute('Fibrra', validPayload, 'actor-1')).rejects.toBeInstanceOf(FinanceTechnologyNotFoundError);
    expect(await repo.getByTechnology('Fibrra')).toBeNull();
  });

  // ── fix-wave-1 A (converged, both reviewers) — Decimal(12,2) can't hold
  // 1e12; must 400 (FinanceValidationError), never reach the repo/DB.
  it('A: rejects costoVentaArs beyond Decimal(12,2) magnitude, no persist', async () => {
    const repo = new InMemoryFinanceTechnologyCostRepository();
    const useCase = new UpdateFinanceTechnologyCost(repo, await catalogWith('Fibra'));

    await expect(
      useCase.execute('Fibra', { ...validPayload, costoVentaArs: 1e12 }, 'actor-1'),
    ).rejects.toBeInstanceOf(FinanceValidationError);
    expect(await repo.getByTechnology('Fibra')).toBeNull();
  });

  // ── fix-wave-1 A — silent companion bug: Postgres' Decimal(5,2) rounds
  // comisionVentaPct server-side, the in-memory double didn't. Rounding
  // explicitly in the use case makes both agree on 5.56 for the same 5.555 input.
  it('A: rounds comisionVentaPct to the column scale (2 decimals) before persisting, matching Postgres rounding', async () => {
    const repo = new InMemoryFinanceTechnologyCostRepository();
    const useCase = new UpdateFinanceTechnologyCost(repo, await catalogWith('Fibra'));

    const result = await useCase.execute('Fibra', { ...validPayload, comisionVentaPct: 5.555 }, 'actor-1');

    expect(result.comisionVentaPct).toBe(5.56);
    expect((await repo.getByTechnology('Fibra'))?.comisionVentaPct).toBe(5.56);
  });
});
