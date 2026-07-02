/**
 * TDD — ListAllPppoeServiceIds (pppoe-bulk-select-filter v2, task 1.6).
 *
 * Liviano: SOLO depende de PppoeServiceRepository (DIP) — sin eventRepo/catalogRepo/nasRepo,
 * a diferencia de ListAllPppoeServices (que enriquece createdBy/nasName). Normaliza
 * `status` (vocabulario de NEGOCIO) → `displayStatus` con la MISMA lógica que
 * ListAllPppoeServices (fail-open: valor desconocido → sin filtro).
 *
 * Uses InMemoryPppoeServiceRepository (real use case, no mocks).
 */
import { ListAllPppoeServiceIds } from '@application/use-cases/ListAllPppoeServiceIds';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';

async function setup() {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const useCase = new ListAllPppoeServiceIds(pppoeRepo);
  return { pppoeRepo, useCase };
}

describe('ListAllPppoeServiceIds — liviano, sin enriquecimiento (pppoe-bulk-select-filter v2)', () => {
  it('sin filtros: devuelve TODOS los ids CON contrato (huérfanos excluidos por default)', async () => {
    const { pppoeRepo, useCase } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'orphan', password: 'x', nasId: 'nas-1', contractId: null });
    const a = await pppoeRepo.upsertByUsername({ username: 'a', password: 'x', nasId: 'nas-1', contractId: 'ct-a' });

    const res = await useCase.execute({});
    expect(res.total).toBe(1);
    expect(res.ids).toEqual([a.id]);
  });

  it('includeUnassigned=true: incluye huérfanos', async () => {
    const { pppoeRepo, useCase } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'orphan', password: 'x', nasId: 'nas-1', contractId: null });
    await pppoeRepo.upsertByUsername({ username: 'a', password: 'x', nasId: 'nas-1', contractId: 'ct-a' });

    const res = await useCase.execute({ includeUnassigned: true });
    expect(res.total).toBe(2);
    expect(res.ids.length).toBe(res.total);
  });

  it('filtra por nasId', async () => {
    const { pppoeRepo, useCase } = await setup();
    const a = await pppoeRepo.upsertByUsername({ username: 'a', password: 'x', nasId: 'nas-1', contractId: 'ct-a' });
    await pppoeRepo.upsertByUsername({ username: 'b', password: 'x', nasId: 'nas-2', contractId: 'ct-b' });

    const res = await useCase.execute({ nasId: 'nas-1' });
    expect(res.total).toBe(1);
    expect(res.ids).toEqual([a.id]);
  });

  it('filtra por search (username)', async () => {
    const { pppoeRepo, useCase } = await setup();
    const juan = await pppoeRepo.upsertByUsername({ username: 'juan', password: 'x', nasId: 'nas-1', contractId: 'ct-1' });
    await pppoeRepo.upsertByUsername({ username: 'pedro', password: 'x', nasId: 'nas-1', contractId: 'ct-2' });

    const res = await useCase.execute({ search: 'jua' });
    expect(res.total).toBe(1);
    expect(res.ids).toEqual([juan.id]);
  });

  it("normaliza status de NEGOCIO 'reduced' → displayStatus, MISMA precedencia que ListAllPppoeServices", async () => {
    const { pppoeRepo, useCase } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'a', password: 'x', nasId: 'nas-1', status: 'enabled', enforcedState: 'active', contractId: 'ct-a' });
    const b = await pppoeRepo.upsertByUsername({ username: 'b', password: 'x', nasId: 'nas-1', status: 'enabled', enforcedState: 'reduced', contractId: 'ct-b' });

    const res = await useCase.execute({ status: 'reduced' });
    expect(res.total).toBe(1);
    expect(res.ids).toEqual([b.id]);
  });

  it('status DESCONOCIDO → fail-open (sin filtro de status, igual que ListAllPppoeServices)', async () => {
    const { pppoeRepo, useCase } = await setup();
    const a = await pppoeRepo.upsertByUsername({ username: 'a', password: 'x', nasId: 'nas-1', status: 'enabled', enforcedState: 'active', contractId: 'ct-a' });
    const b = await pppoeRepo.upsertByUsername({ username: 'b', password: 'x', nasId: 'nas-1', status: 'enabled', enforcedState: 'reduced', contractId: 'ct-b' });

    const res = await useCase.execute({ status: 'no-existe-este-status' });
    expect(res.total).toBe(2);
    expect(res.ids.sort()).toEqual([a.id, b.id].sort());
  });

  it('combinación search+nasId+status (AND)', async () => {
    const { pppoeRepo, useCase } = await setup();
    const match = await pppoeRepo.upsertByUsername({ username: 'juan', password: 'x', nasId: 'nas-1', status: 'enabled', enforcedState: 'active', contractId: 'ct-1' });
    await pppoeRepo.upsertByUsername({ username: 'juanito', password: 'x', nasId: 'nas-2', status: 'enabled', enforcedState: 'active', contractId: 'ct-2' });

    const res = await useCase.execute({ search: 'juan', nasId: 'nas-1', status: 'active' });
    expect(res.total).toBe(1);
    expect(res.ids).toEqual([match.id]);
  });

  it('NO enriquece: el DTO es SOLO { ids, total } — no trae createdBy/nasName/username', async () => {
    const { pppoeRepo, useCase } = await setup();
    await pppoeRepo.upsertByUsername({ username: 'a', password: 'x', nasId: 'nas-1', contractId: 'ct-a' });

    const res = await useCase.execute({});
    expect(Object.keys(res).sort()).toEqual(['ids', 'total']);
  });
});
