import { PreviewEnforcement } from '@application/use-cases/PreviewEnforcement';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';

const NAS_A = '1';
const NAS_B = '2';

async function seedDebtors() {
  const repo = new InMemoryPppoeServiceRepository();
  // 3 pppoe de clientes 'late' (deudores) activos: 2 en router A, 1 en router B
  await repo.upsertByUsername({ username: 'd1', password: 'p', nasId: NAS_A, contractId: 'cA1', enforcedState: 'active' });
  await repo.upsertByUsername({ username: 'd2', password: 'p', nasId: NAS_A, contractId: 'cA2', enforcedState: 'active' });
  await repo.upsertByUsername({ username: 'd3', password: 'p', nasId: NAS_B, contractId: 'cB1', enforcedState: 'active' });
  // 1 deudor YA reducido → no es candidato a 'reduce' (target alcanzado)
  await repo.upsertByUsername({ username: 'd4', password: 'p', nasId: NAS_A, contractId: 'cA3', enforcedState: 'reduced' });
  // 1 cliente al día (no late) → nunca candidato de 'debtors'
  await repo.upsertByUsername({ username: 'ok1', password: 'p', nasId: NAS_A, contractId: 'cOk', enforcedState: 'active' });

  ['cA1', 'cA2', 'cB1', 'cA3'].forEach(c => repo.setContractClientStatus(c, 'late'));
  repo.setContractClientStatus('cOk', 'active');
  return repo;
}

describe('PreviewEnforcement (Fase C — preview sin ejecutar)', () => {
  it('debtors + reduce: total + byRouter + sample de los candidatos; excluye los ya reducidos y los no-late', async () => {
    const repo = await seedDebtors();
    const preview = new PreviewEnforcement(repo);

    const out = await preview.execute({ action: 'reduce', target: 'debtors' });

    expect(out.total).toBe(3);                 // d1, d2, d3 (d4 ya reduced, ok1 no es late)
    expect(out.byRouter[NAS_A]).toBe(2);
    expect(out.byRouter[NAS_B]).toBe(1);
    expect(out.pppoeIds).toHaveLength(3);
    expect(out.sample.length).toBeGreaterThan(0);
    // el sample no expone password
    for (const item of out.sample) {
      expect((item as unknown as Record<string, unknown>)['password']).toBeUndefined();
    }
  });

  it('NO tiene efectos colaterales: no cambia ningún enforcedState', async () => {
    const repo = await seedDebtors();
    const preview = new PreviewEnforcement(repo);
    await preview.execute({ action: 'reduce', target: 'debtors' });

    const all = await repo.list();
    const byUser = Object.fromEntries(all.map(s => [s.username, s.enforcedState]));
    expect(byUser['d1']).toBe('active');
    expect(byUser['d4']).toBe('reduced');
  });

  it('target lista explícita {pppoeIds}: resuelve por id y filtra por estado destino', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const a = await repo.upsertByUsername({ username: 'a', password: 'p', nasId: NAS_A, contractId: 'c', enforcedState: 'active' });
    const b = await repo.upsertByUsername({ username: 'b', password: 'p', nasId: NAS_A, contractId: 'c', enforcedState: 'blocked' });
    const preview = new PreviewEnforcement(repo);

    const out = await preview.execute({ action: 'block', target: { pppoeIds: [a.id, b.id] } });

    expect(out.total).toBe(1);                 // 'a' (b ya está blocked)
    expect(out.pppoeIds).toEqual([a.id]);
  });

  it('target {clientStatus}: resuelve por status arbitrario (ej. baja → block)', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    await repo.upsertByUsername({ username: 'x', password: 'p', nasId: NAS_A, contractId: 'cx', enforcedState: 'active' });
    repo.setContractClientStatus('cx', 'baja');
    const preview = new PreviewEnforcement(repo);

    const out = await preview.execute({ action: 'block', target: { clientStatus: 'baja' } });
    expect(out.total).toBe(1);
  });
});
