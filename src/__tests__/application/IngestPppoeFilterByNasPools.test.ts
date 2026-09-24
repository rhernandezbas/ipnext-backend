/**
 * IngestPppoeFilterByNasPools.test.ts — ingest-pppoe-filter-by-nas-pools.
 *
 * Bug: IngestPppoeFromNas atribuía TODOS los usuarios devueltos por
 * `orchestrator.listUsers()` (inventario del RADIUS HA COMPARTIDO, de MUCHOS NAS) al NAS
 * pedido, sin filtrar. Medición real: ingerir el NAS Agote sumaba 748 usuarios correctos
 * MÁS 7 de otros NAS (uno con framedIp de un cliente del NE8000, uno CGNAT de otro router,
 * un healthcheck `hc-keepalived` sin IP).
 *
 * Fix: sólo se ingiere un item si su `framedIp` es una IPv4 válida que cae en alguno de los
 * pools (`IpPool.rangeStart..rangeEnd`, inclusive) del NAS (`findPoolsByNas`). Sin pools →
 * `PppoeNasHasNoPoolsError` en vez de ingerir todo a ciegas.
 */
import { IngestPppoeFromNas } from '@application/use-cases/IngestPppoeFromNas';

import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';

import { PppoeNasHasNoPoolsError } from '@domain/errors/pppoe';
import { IpPool } from '@domain/entities/network';

// NAS seed del InMemoryNasRepository: id '3' = radius_orchestrator
const RADIUS_NAS = '3';

function pool(overrides: Partial<IpPool> & Pick<IpPool, 'id' | 'rangeStart' | 'rangeEnd'>): IpPool {
  return {
    name: `pool-${overrides.id}`,
    networkId: 'net-1',
    type: 'static',
    assignedCount: 0,
    totalCount: 100,
    nasId: RADIUS_NAS,
    ipKind: null,
    ...overrides,
  };
}

function makeIpNetworkRepo(pools: IpPool[]): InMemoryIpNetworkRepository {
  const repo = new InMemoryIpNetworkRepository();
  // Limpia los pools default (no ligados a RADIUS_NAS) para que los tests sean deterministas.
  (repo as unknown as { pools: IpPool[] }).pools = [];
  for (const p of pools) repo.seedPool(p);
  return repo;
}

// Dos pools del NAS Agote (uno CGNAT, uno público), coherentes con el caso real reportado.
const AGOTE_POOLS = [
  pool({ id: 'agote-public', rangeStart: '190.7.226.33', rangeEnd: '190.7.226.254' }),
  pool({ id: 'agote-cgnat', rangeStart: '100.64.3.2', rangeEnd: '100.64.3.254' }),
];

describe('IngestPppoeFromNas — filtro de pertenencia por pools del NAS', () => {
  it('framedIp dentro de un pool del NAS → se ingiere con ese nasId', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const ipNetworkRepo = makeIpNetworkRepo(AGOTE_POOLS);
    const orch = new InMemoryRadiusOrchestratorGateway({
      usersInventory: [
        { username: 'clienteAgote', password: 'pw', plan: 'IP-Air-30-10', framedIp: '190.7.226.100' },
      ],
    });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch, ipNetworkRepo);

    const result = await uc.execute(RADIUS_NAS);

    expect(result).toEqual({ created: 1, skipped: 0, excluded: 0, skippedOtherNas: 0 });
    const created = await repo.findByUsername('clienteAgote');
    expect(created?.nasId).toBe(RADIUS_NAS);
  });

  it('framedIp fuera de TODOS los pools del NAS (ej. cliente del NE8000) → NO se ingiere, cuenta skippedOtherNas', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const ipNetworkRepo = makeIpNetworkRepo(AGOTE_POOLS);
    const orch = new InMemoryRadiusOrchestratorGateway({
      usersInventory: [
        { username: 'clienteNE8000', password: 'pw', plan: 'IP-Fibra-100', framedIp: '190.7.247.156' },
      ],
    });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch, ipNetworkRepo);

    const result = await uc.execute(RADIUS_NAS);

    expect(result).toEqual({ created: 0, skipped: 0, excluded: 0, skippedOtherNas: 1 });
    expect(await repo.findByUsername('clienteNE8000')).toBeNull();
  });

  it('framedIp null (ej. healthcheck hc-keepalived) → NO se ingiere', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const ipNetworkRepo = makeIpNetworkRepo(AGOTE_POOLS);
    const orch = new InMemoryRadiusOrchestratorGateway({
      usersInventory: [
        { username: 'hc-keepalived', password: 'pw', plan: null, framedIp: null },
      ],
    });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch, ipNetworkRepo);

    const result = await uc.execute(RADIUS_NAS);

    expect(result).toEqual({ created: 0, skipped: 0, excluded: 0, skippedOtherNas: 1 });
    expect(await repo.findByUsername('hc-keepalived')).toBeNull();
  });

  it('bordes de rango inclusivos: rangeStart y rangeEnd se ingieren; justo antes del start NO', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const ipNetworkRepo = makeIpNetworkRepo(AGOTE_POOLS);
    const orch = new InMemoryRadiusOrchestratorGateway({
      usersInventory: [
        { username: 'atRangeStart', password: 'pw', plan: 'P1', framedIp: '100.64.3.2' },   // == rangeStart
        { username: 'atRangeEnd',   password: 'pw', plan: 'P1', framedIp: '100.64.3.254' },  // == rangeEnd
        { username: 'beforeStart',  password: 'pw', plan: 'P1', framedIp: '100.64.3.1' },    // rangeStart - 1
      ],
    });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch, ipNetworkRepo);

    const result = await uc.execute(RADIUS_NAS);

    expect(result).toEqual({ created: 2, skipped: 0, excluded: 0, skippedOtherNas: 1 });
    expect(await repo.findByUsername('atRangeStart')).not.toBeNull();
    expect(await repo.findByUsername('atRangeEnd')).not.toBeNull();
    expect(await repo.findByUsername('beforeStart')).toBeNull();
  });

  it('NAS radius_orchestrator SIN pools → PppoeNasHasNoPoolsError, nada se escribe', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const ipNetworkRepo = makeIpNetworkRepo([]); // sin pools para RADIUS_NAS
    const orch = new InMemoryRadiusOrchestratorGateway({
      usersInventory: [
        { username: 'cualquiera', password: 'pw', plan: 'P1', framedIp: '100.64.3.2' },
      ],
    });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch, ipNetworkRepo);

    await expect(uc.execute(RADIUS_NAS)).rejects.toBeInstanceOf(PppoeNasHasNoPoolsError);
    expect(await repo.findByUsername('cualquiera')).toBeNull();
  });

  it('comparación NUMÉRICA (no string): 190.7.226.100 cae dentro de 190.7.226.33-190.7.226.254; 190.7.226.9 queda afuera', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const ipNetworkRepo = makeIpNetworkRepo(AGOTE_POOLS);
    const orch = new InMemoryRadiusOrchestratorGateway({
      usersInventory: [
        // Comparación de strings pondría '190.7.226.100' < '190.7.226.33' (char a char) → bug.
        { username: 'dentro',  password: 'pw', plan: 'P1', framedIp: '190.7.226.100' },
        { username: 'afuera',  password: 'pw', plan: 'P1', framedIp: '190.7.226.9' },
      ],
    });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch, ipNetworkRepo);

    const result = await uc.execute(RADIUS_NAS);

    expect(result).toEqual({ created: 1, skipped: 0, excluded: 0, skippedOtherNas: 1 });
    expect(await repo.findByUsername('dentro')).not.toBeNull();
    expect(await repo.findByUsername('afuera')).toBeNull();
  });
});
