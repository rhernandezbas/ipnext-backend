/**
 * terminatePppoe.contractId.test.ts
 *
 * Bug: TerminatePppoeService preservaba el contractId al dar de baja un PPPoE.
 * Eso causaba dos problemas:
 *   1. El PPPoE terminated NO aparecía en findUnassigned() (WHERE contractId IS NULL)
 *      → el operador no podía re-asociarlo desde el selector.
 *   2. ListRadiusSessions devolvía contractId no-null para sesiones de un PPPoE terminated
 *      → el FE no mostraba el ⚠ aunque el contrato no tuviera servicio de internet activo.
 *
 * Fix esperado: al terminar un PPPoE, el contractId se pone NULL.
 */
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { TerminatePppoeService } from '@application/use-cases/TerminatePppoeService';

const NAS_RADIUS_ID = '3'; // radius_orchestrator (InMemoryNasRepository seed)
const CONTRACT_ID   = 'contract-abc';

function buildUseCase() {
  const pppoeRepo   = new InMemoryPppoeServiceRepository();
  const nasRepo     = new InMemoryNasRepository();
  const orchestrator = new InMemoryRadiusOrchestratorGateway();
  const routerGw    = new InMemoryRouterGateway();
  const csRepo      = new InMemoryContractServiceRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const eventRepo   = new InMemoryContractServiceEventRepository();
  const ensure      = new EnsureInternetContractService(csRepo, catalogRepo, eventRepo);

  const terminatePppoe = new TerminatePppoeService(pppoeRepo, orchestrator, routerGw, nasRepo, ensure);
  return { pppoeRepo, terminatePppoe };
}

describe('TerminatePppoeService — contractId se pone null al dar de baja', () => {
  it('el PPPoE terminated queda con contractId=null (no con el contractId original)', async () => {
    const { pppoeRepo, terminatePppoe } = buildUseCase();

    const pppoe = await pppoeRepo.upsertByUsername({
      username:      'CintiaMoyanoMercFibra',
      password:      'secret123',
      profile:       'IP-Fibra-100',
      remoteAddress: '100.64.9.245',
      status:        'enabled',
      nasId:         NAS_RADIUS_ID,
      contractId:    CONTRACT_ID,
    });

    const result = await terminatePppoe.execute(pppoe.id);

    expect(result.status).toBe('terminated');
    expect(result.contractId).toBeNull();
  });

  it('el PPPoE terminated aparece en findUnassigned() para poder re-asociarlo', async () => {
    const { pppoeRepo, terminatePppoe } = buildUseCase();

    const pppoe = await pppoeRepo.upsertByUsername({
      username:      'CintiaMoyanoMercFibra',
      password:      'secret123',
      profile:       'IP-Fibra-100',
      remoteAddress: '100.64.9.245',
      status:        'enabled',
      nasId:         NAS_RADIUS_ID,
      contractId:    CONTRACT_ID,
    });

    await terminatePppoe.execute(pppoe.id);

    const unassigned = await pppoeRepo.findUnassigned();
    const found = unassigned.find(p => p.username === 'CintiaMoyanoMercFibra');
    expect(found).toBeDefined();
    expect(found?.status).toBe('terminated');
    expect(found?.contractId).toBeNull();
  });
});
