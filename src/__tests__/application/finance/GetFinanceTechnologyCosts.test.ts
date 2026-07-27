import { GetFinanceTechnologyCosts } from '@application/use-cases/finance/GetFinanceTechnologyCosts';
import { InMemoryFinanceTechnologyCostRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceTechnologyCostRepository';
import { InMemoryContractTechnologyRepository } from '@infrastructure/adapters/in-memory/InMemoryContractTechnologyRepository';

describe('GetFinanceTechnologyCosts (task 2.6)', () => {
  it('LEFT JOIN: a technology with no configured cost row appears with ALL costs at 0, never omitted', async () => {
    const technologies = new InMemoryContractTechnologyRepository();
    await technologies.create({ name: 'Fibra', description: null });
    await technologies.create({ name: 'Wireless', description: null });
    const costs = new InMemoryFinanceTechnologyCostRepository();
    // Only "Fibra" has a configured row — "Wireless" never got one.
    await costs.upsert('Fibra', {
      costoVentaArs: 15000,
      costoInstalacionArs: 20000,
      costoMensualServicioArs: 3000,
      comisionVentaPct: 5,
      updatedByUserId: 'u1',
    });

    const useCase = new GetFinanceTechnologyCosts(costs, technologies);
    const result = await useCase.execute();

    expect(result).toHaveLength(2);
    const fibra = result.find((r) => r.technologyName === 'Fibra');
    const wireless = result.find((r) => r.technologyName === 'Wireless');
    expect(fibra).toMatchObject({
      technologyName: 'Fibra',
      costoVentaArs: 15000,
      costoInstalacionArs: 20000,
      costoMensualServicioArs: 3000,
      comisionVentaPct: 5,
    });
    expect(fibra?.updatedAt).not.toBeNull();
    // The never-configured technology is NOT omitted — it appears with zeros.
    expect(wireless).toMatchObject({
      technologyName: 'Wireless',
      costoVentaArs: 0,
      costoInstalacionArs: 0,
      costoMensualServicioArs: 0,
      comisionVentaPct: 0,
    });
    expect(wireless?.updatedAt).toBeNull();
  });

  it('no technologies at all → empty array, never throws', async () => {
    const useCase = new GetFinanceTechnologyCosts(
      new InMemoryFinanceTechnologyCostRepository(),
      new InMemoryContractTechnologyRepository(),
    );
    expect(await useCase.execute()).toEqual([]);
  });
});
