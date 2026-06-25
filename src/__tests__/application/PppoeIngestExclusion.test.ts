/**
 * PppoeIngestExclusion.test.ts — Bug 1: filtro de usernames placeholder en ingest.
 *
 * TDD (rojo → verde → refactor):
 *   - IngestPppoeFromNas: respeta exclusionPatterns → excluye accesosurN, persiste juanperez.
 *     Result diferencia skipped (existentes) de excluded (filtrados por patrón).
 *   - ListUnassignedPppoe: secondary filter — no muestra entradas que matcheen el patrón
 *     aunque hayan llegado a la DB (defence-in-depth).
 */
import { IngestPppoeFromNas } from '@application/use-cases/IngestPppoeFromNas';
import { ListUnassignedPppoe } from '@application/use-cases/ListUnassignedPppoe';

import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';

// NAS seed del InMemoryNasRepository: id '3' = radius_orchestrator
const RADIUS_NAS = '3';

const MIXED_INVENTORY = [
  { username: 'juanperez',  password: 'pass1234', plan: 'IP-Air-30-10', framedIp: '100.64.10.10' },
  { username: 'accesosur1', password: 'pw',       plan: null,           framedIp: null },
  { username: 'accesosur2', password: 'pw2',      plan: null,           framedIp: null },
  { username: 'mariam',     password: 'otra',     plan: null,           framedIp: null },
];

const EXCLUDE = [/^accesosur\d+$/i];

describe('IngestPppoeFromNas — exclusionPatterns (Bug 1)', () => {
  it('con exclusionPatterns filtra accesosurN y persiste el resto', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const orch = new InMemoryRadiusOrchestratorGateway({ usersInventory: MIXED_INVENTORY });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch, EXCLUDE);

    const result = await uc.execute(RADIUS_NAS);

    // juanperez + mariam creados; accesosur1 + accesosur2 excluidos
    expect(result.created).toBe(2);
    expect(result.excluded).toBe(2);
    expect(result.skipped).toBe(0);

    // Las entradas excluidas NO deben estar en el repo
    expect(await repo.findByUsername('accesosur1')).toBeNull();
    expect(await repo.findByUsername('accesosur2')).toBeNull();

    // Las legítimas sí
    expect(await repo.findByUsername('juanperez')).not.toBeNull();
    expect(await repo.findByUsername('mariam')).not.toBeNull();
  });

  it('sin exclusionPatterns: comportamiento sin cambios (BC)', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const orch = new InMemoryRadiusOrchestratorGateway({ usersInventory: MIXED_INVENTORY });
    // Sin pasar exclusionPatterns → usa default []
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch);

    const result = await uc.execute(RADIUS_NAS);

    expect(result.created).toBe(4);
    expect(result.excluded).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('excluded y skipped son contadores INDEPENDIENTES', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();

    // Preexiste juanperez en la DB
    await repo.upsertByUsername({ username: 'juanperez', password: 'OLD', nasId: RADIUS_NAS, contractId: 'C1' });

    const orch = new InMemoryRadiusOrchestratorGateway({ usersInventory: MIXED_INVENTORY });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch, EXCLUDE);

    const result = await uc.execute(RADIUS_NAS);

    // juanperez → skipped (existía); accesosur1+2 → excluded; mariam → created
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.excluded).toBe(2);

    // juanperez intacto (no clobbered)
    expect((await repo.findByUsername('juanperez'))?.password).toBe('OLD');
    expect((await repo.findByUsername('juanperez'))?.contractId).toBe('C1');
  });

  it('case-insensitive: AccesoSur1 también se excluye', async () => {
    const inventory = [
      { username: 'AccesoSur1', password: 'pw', plan: null, framedIp: null },
      { username: 'normal',     password: 'pw', plan: null, framedIp: null },
    ];
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const orch = new InMemoryRadiusOrchestratorGateway({ usersInventory: inventory });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch, EXCLUDE);

    const result = await uc.execute(RADIUS_NAS);

    expect(result.created).toBe(1);
    expect(result.excluded).toBe(1);
    expect(await repo.findByUsername('AccesoSur1')).toBeNull();
    expect(await repo.findByUsername('normal')).not.toBeNull();
  });
});

describe('ListUnassignedPppoe — exclusionPatterns secondary filter (Bug 1)', () => {
  it('defence-in-depth: exclude del listado si el username matchea el patrón', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    // Simula entidades en DB que igual deben filtrarse (defence-in-depth)
    await repo.upsertByUsername({ username: 'orphan1',    password: 'p', nasId: RADIUS_NAS, contractId: null });
    await repo.upsertByUsername({ username: 'accesosur1', password: 'p', nasId: RADIUS_NAS, contractId: null });
    await repo.upsertByUsername({ username: 'asociado',   password: 'p', nasId: RADIUS_NAS, contractId: 'C1' });

    const uc = new ListUnassignedPppoe(repo, EXCLUDE);
    const list = await uc.execute();

    // solo orphan1 (asociado está asignado; accesosur1 filtrado por patrón)
    expect(list.map(s => s.username)).toEqual(['orphan1']);
  });

  it('sin exclusionPatterns: comportamiento sin cambios (BC)', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    await repo.upsertByUsername({ username: 'orphan1',    password: 'p', nasId: RADIUS_NAS, contractId: null });
    await repo.upsertByUsername({ username: 'accesosur1', password: 'p', nasId: RADIUS_NAS, contractId: null });

    const uc = new ListUnassignedPppoe(repo);
    const list = await uc.execute();

    // ambos aparecen (sin filtro)
    expect(list).toHaveLength(2);
  });
});
