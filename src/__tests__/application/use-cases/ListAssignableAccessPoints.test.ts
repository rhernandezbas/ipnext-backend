/**
 * ListAssignableAccessPoints — catálogo de APs asignables para el picker manual (PICK-2).
 * Filtra retirados (missingSince != null) — esos NO se listan como asignables, aunque un
 * contrato ya asignado a uno no se rompa (Fase A FIX-2). Orden name asc.
 */
import { ListAssignableAccessPoints } from '@application/use-cases/ListAssignableAccessPoints';
import { InMemoryAccessPointRepository } from '@infrastructure/adapters/in-memory/InMemoryAccessPointRepository';

describe('ListAssignableAccessPoints', () => {
  it('filtra los APs retirados y filtra por networkSiteId', async () => {
    const repo = new InMemoryAccessPointRepository();
    const a1 = await repo.upsertByUispDeviceId({ uispDeviceId: 'dev-a1', networkSiteId: 'N1', name: 'AP A1', mac: 'aa:bb:cc:dd:ee:01' });
    await repo.upsertByUispDeviceId({ uispDeviceId: 'dev-a2', networkSiteId: 'N1', name: 'AP A2', mac: null });
    await repo.markMissing(['dev-a2'], new Date('2026-01-01T00:00:00Z')); // A2 retirado
    await repo.upsertByUispDeviceId({ uispDeviceId: 'dev-a3', networkSiteId: 'N2', name: 'AP A3', mac: null });
    const uc = new ListAssignableAccessPoints(repo);

    const result = await uc.execute({ networkSiteId: 'N1' });

    expect(result).toEqual([{ id: a1.id, name: 'AP A1', mac: 'aa:bb:cc:dd:ee:01', networkSiteId: 'N1' }]);
  });

  it('sin networkSiteId, lista TODOS los asignables (no retirados) de todos los nodos', async () => {
    const repo = new InMemoryAccessPointRepository();
    await repo.upsertByUispDeviceId({ uispDeviceId: 'dev-b1', networkSiteId: 'N1', name: 'AP B1', mac: null });
    await repo.upsertByUispDeviceId({ uispDeviceId: 'dev-b2', networkSiteId: 'N2', name: 'AP B2', mac: null });
    const uc = new ListAssignableAccessPoints(repo);

    const result = await uc.execute({});

    expect(result.map((r) => r.name)).toEqual(['AP B1', 'AP B2']);
  });

  it('ordena por name ascendente', async () => {
    const repo = new InMemoryAccessPointRepository();
    await repo.upsertByUispDeviceId({ uispDeviceId: 'dev-z', networkSiteId: 'N1', name: 'Zeta AP', mac: null });
    await repo.upsertByUispDeviceId({ uispDeviceId: 'dev-a', networkSiteId: 'N1', name: 'Alfa AP', mac: null });
    await repo.upsertByUispDeviceId({ uispDeviceId: 'dev-m', networkSiteId: 'N1', name: 'Medio AP', mac: null });
    const uc = new ListAssignableAccessPoints(repo);

    const result = await uc.execute({});

    expect(result.map((r) => r.name)).toEqual(['Alfa AP', 'Medio AP', 'Zeta AP']);
  });

  it('mapea al DTO AccessPointOptionDto exacto — nunca la entidad cruda', async () => {
    const repo = new InMemoryAccessPointRepository();
    await repo.upsertByUispDeviceId({ uispDeviceId: 'dev-c1', networkSiteId: 'N1', name: 'AP C1', mac: 'aa:bb:cc:dd:ee:02' });
    const uc = new ListAssignableAccessPoints(repo);

    const [dto] = await uc.execute({});

    expect(Object.keys(dto).sort()).toEqual(['id', 'mac', 'name', 'networkSiteId']);
  });
});
