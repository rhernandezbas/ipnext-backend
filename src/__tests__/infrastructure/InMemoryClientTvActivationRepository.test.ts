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

  // gigared-tv-identity-hardening F1 — ensureSeqAtLeast: avance DIFERIDO e idempotente del seq.
  // El seq se acuña recién tras identidad verificada en el partner (register+stamp+verify OK);
  // los retries recomputan el MISMO candidato y convergen. La operación NUNCA retrocede.
  it('ensureSeqAtLeast — sube el seq a n cuando el almacenado es menor', async () => {
    const repo = new InMemoryClientTvActivationRepository();
    await repo.ensureSeqAtLeast('cust-1', 3);
    expect(await repo.getSeq('cust-1')).toBe(3);
  });

  it('ensureSeqAtLeast — NUNCA retrocede: n menor que el almacenado no lo baja', async () => {
    const repo = new InMemoryClientTvActivationRepository();
    repo.seedSeq('cust-1', 5);
    await repo.ensureSeqAtLeast('cust-1', 2);
    expect(await repo.getSeq('cust-1')).toBe(5);
  });

  it('ensureSeqAtLeast — idempotente: llamarlo con el MISMO candidato no lo mueve', async () => {
    const repo = new InMemoryClientTvActivationRepository();
    await repo.ensureSeqAtLeast('cust-1', 1);
    await repo.ensureSeqAtLeast('cust-1', 1);
    expect(await repo.getSeq('cust-1')).toBe(1);
  });

  it('ensureSeqAtLeast — por cliente, no se pisan', async () => {
    const repo = new InMemoryClientTvActivationRepository();
    await repo.ensureSeqAtLeast('cust-1', 4);
    expect(await repo.getSeq('cust-1')).toBe(4);
    expect(await repo.getSeq('cust-2')).toBe(0);
  });
});
