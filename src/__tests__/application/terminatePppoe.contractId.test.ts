/**
 * terminatePppoe.contractId.test.ts
 *
 * TerminatePppoeService hace BORRADO HARD de la fila (deleteById).
 * El username queda completamente libre para ser re-ingresado desde el router
 * sin ningún conflicto ni residuo en la DB.
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

describe('TerminatePppoeService — borrado HARD de la fila (baja total)', () => {
  it('la fila es eliminada completamente de la DB tras la baja', async () => {
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

    const afterBaja = await pppoeRepo.findByUsername('CintiaMoyanoMercFibra');
    expect(afterBaja).toBeNull();
  });

  it('el username NO aparece en findUnassigned() (no hay fila huérfana)', async () => {
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
    expect(found).toBeUndefined();
  });

  it('el ingest puede crear el username de cero después de la baja (no hay conflicto UNIQUE)', async () => {
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

    // Simula re-ingest desde el router (fresh entry, contractId=null)
    const reingested = await pppoeRepo.upsertByUsername({
      username:   'CintiaMoyanoMercFibra',
      password:   'secret123',
      profile:    'IP-Fibra-100',
      nasId:      NAS_RADIUS_ID,
      contractId: null,
    });

    expect(reingested.status).toBe('enabled');
    expect(reingested.contractId).toBeNull();

    // Y aparece como huérfano disponible para asociar
    const unassigned = await pppoeRepo.findUnassigned();
    expect(unassigned.find(p => p.username === 'CintiaMoyanoMercFibra')).toBeDefined();
  });
});
