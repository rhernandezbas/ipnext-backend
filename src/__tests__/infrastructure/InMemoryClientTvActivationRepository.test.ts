/**
 * #81 — contador de reactivaciones de TV por cliente. incrementSeq es atómico y devuelve el
 * NUEVO valor; getSeq lee el actual (0 por default cuando el cliente nunca reactivó).
 */
import { InMemoryClientTvActivationRepository } from '@infrastructure/adapters/in-memory/InMemoryClientTvActivationRepository';

describe('#81 InMemoryClientTvActivationRepository', () => {
  it('getSeq → 0 para un cliente sin reactivaciones', async () => {
    const repo = new InMemoryClientTvActivationRepository();
    expect(await repo.getSeq('cust-1')).toBe(0);
  });

  it('incrementSeq → devuelve el NUEVO seq y persiste (1, 2, 3…)', async () => {
    const repo = new InMemoryClientTvActivationRepository();
    expect(await repo.incrementSeq('cust-1')).toBe(1);
    expect(await repo.incrementSeq('cust-1')).toBe(2);
    expect(await repo.getSeq('cust-1')).toBe(2);
  });

  it('seq por cliente — clientes distintos no se pisan', async () => {
    const repo = new InMemoryClientTvActivationRepository();
    await repo.incrementSeq('cust-1');
    expect(await repo.getSeq('cust-1')).toBe(1);
    expect(await repo.getSeq('cust-2')).toBe(0);
  });

  it('seedSeq — helper de test pre-setea el contador', async () => {
    const repo = new InMemoryClientTvActivationRepository();
    repo.seedSeq('cust-1', 5);
    expect(await repo.getSeq('cust-1')).toBe(5);
    expect(await repo.incrementSeq('cust-1')).toBe(6);
  });
});
