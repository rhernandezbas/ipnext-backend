import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { ListNasServers } from '@application/use-cases/ListNasServers';
import { IpPool } from '@domain/entities/network';
import { NasServer, NasType } from '@domain/entities/nas';

/**
 * pppoe-move-ip-kind-aware (Fase 2) — `supportedIpKinds` en el DTO de NAS.
 *
 * Campo ADITIVO de presentación (molde de `displayType`): derivado de los pools, NO persistido,
 * sin migración. Dos consumidores: el move (autoridad) y el FE (qué tipos ofrecer).
 *
 * ⚠️ El test central es "el orchestrator caído NO borra las clases". En `enrich()` la lectura
 * de pools (DB, confiable) y la de sesiones (orchestrator, falible) compartían un solo `try`:
 * calcular las clases ahí las haría desaparecer cada vez que el RADIUS esté caído, y el FE
 * —sin clases— esconde ambos botones y bloquea la operación por una causa no relacionada.
 */

function nas(id: string, name: string, type: NasType): NasServer {
  return {
    id,
    name,
    type,
    ipAddress: '10.75.0.30',
    radiusSecret: '••••••••',
    nasIpAddress: '10.75.0.30',
    apiPort: null,
    apiLogin: null,
    apiPassword: null,
    status: 'active',
    lastSeen: '2026-01-01T00:00:00Z',
    clientCount: 7,
    description: name,
  };
}

function pool(id: string, nasId: string, ipKind: IpPool['ipKind']): IpPool {
  return {
    id,
    name: `pool-${id}`,
    networkId: `net-${id}`,
    rangeStart: '190.7.229.66',
    rangeEnd: '190.7.229.94',
    type: 'static',
    assignedCount: 0,
    totalCount: 29,
    nasId,
    ipKind,
  };
}

function makeIpNetworkRepo(pools: IpPool[]): InMemoryIpNetworkRepository {
  const repo = new InMemoryIpNetworkRepository();
  (repo as unknown as { pools: IpPool[] }).pools = [];
  for (const p of pools) repo.seedPool(p);
  return repo;
}

function makeNasRepo(servers: NasServer[]): InMemoryNasRepository {
  const repo = new InMemoryNasRepository();
  (repo as unknown as { nasServers: NasServer[] }).nasServers = [...servers];
  return repo;
}

const NE8000 = nas('ne8000', 'NE8000 - Mercedes', 'radius_orchestrator');
const AGOTE = nas('agote', 'RDA Agote Gownland', 'radius_orchestrator');
const LEGACY = nas('legacy', 'MikroTik viejo', 'mikrotik_api');

describe('supportedIpKinds en el DTO de NAS', () => {
  it('NAS public-only expone solo public (caso real: NE8000, 18 pools public / 0 cgnat)', async () => {
    const uc = new ListNasServers(
      makeNasRepo([NE8000]),
      makeIpNetworkRepo([pool('a', 'ne8000', 'public'), pool('b', 'ne8000', 'public')]),
      new InMemoryRadiusOrchestratorGateway({ globalSessions: [] }),
    );

    const [dto] = await uc.execute();
    expect(dto.supportedIpKinds).toEqual(['public']);
  });

  it('NAS con ambas clases expone las dos (caso real: RDA Agote, 3 cgnat + 2 public)', async () => {
    const uc = new ListNasServers(
      makeNasRepo([AGOTE]),
      makeIpNetworkRepo([pool('a', 'agote', 'cgnat'), pool('b', 'agote', 'public')]),
      new InMemoryRadiusOrchestratorGateway({ globalSessions: [] }),
    );

    const [dto] = await uc.execute();
    expect(dto.supportedIpKinds).toEqual(['cgnat', 'public']);
  });

  it('NAS sin pools expone [] (NO asume ninguna clase)', async () => {
    const uc = new ListNasServers(
      makeNasRepo([NE8000]),
      makeIpNetworkRepo([]),
      new InMemoryRadiusOrchestratorGateway({ globalSessions: [] }),
    );

    const [dto] = await uc.execute();
    expect(dto.supportedIpKinds).toEqual([]);
  });

  // ── El test que justifica el try separado ────────────────────────────────────
  it('orchestrator CAIDO: las clases siguen presentes y los contadores degradan al stored', async () => {
    const uc = new ListNasServers(
      makeNasRepo([NE8000]),
      makeIpNetworkRepo([pool('a', 'ne8000', 'public')]),
      new InMemoryRadiusOrchestratorGateway({ globalSessions: [], globalSessionsUnreachable: true }),
    );

    const [dto] = await uc.execute();

    expect(dto.supportedIpKinds).toEqual(['public']);   // ← NO se pierde
    expect(dto.clientCount).toBe(7);                    // stored (comportamiento actual)
    expect(dto.displayType).toBe('BRAS RADIUS');
  });

  it('NAS que NO rutea por orchestrator tambien trae las clases (early-return)', async () => {
    const uc = new ListNasServers(
      makeNasRepo([LEGACY]),
      makeIpNetworkRepo([pool('a', 'legacy', 'cgnat')]),
      new InMemoryRadiusOrchestratorGateway({ globalSessions: [] }),
    );

    const [dto] = await uc.execute();
    expect(dto.supportedIpKinds).toEqual(['cgnat']);
    expect(dto.displayType).toBe('mikrotik_api');
  });

  it('fallo al leer pools: clases [] y la request NO falla (best-effort)', async () => {
    const ipNetworkRepo = makeIpNetworkRepo([pool('a', 'ne8000', 'public')]);
    jest.spyOn(ipNetworkRepo, 'findPoolsByNas').mockRejectedValue(new Error('db down'));

    const uc = new ListNasServers(
      makeNasRepo([NE8000]),
      ipNetworkRepo,
      new InMemoryRadiusOrchestratorGateway({ globalSessions: [] }),
    );

    const result = await uc.execute();

    expect(result).toHaveLength(1);
    expect(result[0].supportedIpKinds).toEqual([]);
  });
});
