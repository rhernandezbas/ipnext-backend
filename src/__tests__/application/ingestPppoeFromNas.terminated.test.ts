/**
 * ingestPppoeFromNas.terminated.test.ts
 *
 * Bug: IngestPppoeFromNas skipeaba CUALQUIER username existente, incluyendo los
 * que tienen status='terminated' (dados de baja). Si el operador recreaba el PPPoE
 * manualmente en el router y corría el ingest, el registro terminated permanecía intacto
 * → el PPPoE nunca se actualizaba con los nuevos datos del router.
 *
 * Fix esperado: si el registro existente tiene status='terminated', el ingest LO ACTUALIZA
 * (lo trata como un re-alta) en lugar de skipearlo.
 */
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { IngestPppoeFromNas } from '@application/use-cases/IngestPppoeFromNas';

const NAS_RADIUS_ID = '3'; // radius_orchestrator (InMemoryNasRepository seed)

describe('IngestPppoeFromNas — re-ingest de registros terminated', () => {
  it('re-ingesta un PPPoE terminated (lo pone enabled+contractId null) en vez de skipearlo', async () => {
    const pppoeRepo   = new InMemoryPppoeServiceRepository();
    const nasRepo     = new InMemoryNasRepository();
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      usersInventory: [
        { username: 'CintiaMoyanoMercFibra', password: 'newpass', plan: 'IP-Fibra-100', framedIp: '100.64.9.245' },
      ],
    });
    const ingest = new IngestPppoeFromNas(pppoeRepo, nasRepo, orchestrator);

    // Simular el estado post-baja: terminated + contractId=null (después del fix de TerminatePppoeService)
    await pppoeRepo.upsertByUsername({
      username:      'CintiaMoyanoMercFibra',
      password:      'oldpass',
      profile:       'IP-Fibra-100',
      remoteAddress: null,
      status:        'terminated',
      nasId:         NAS_RADIUS_ID,
      contractId:    null,
    });

    const result = await ingest.execute(NAS_RADIUS_ID);

    // El terminated fue re-ingresado (no skipeado)
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);

    const refreshed = await pppoeRepo.findByUsername('CintiaMoyanoMercFibra');
    expect(refreshed).not.toBeNull();
    expect(refreshed?.status).toBe('enabled');
    expect(refreshed?.password).toBe('newpass');
    expect(refreshed?.contractId).toBeNull();
  });

  it('sigue skipeando un PPPoE enabled (no toca registros activos)', async () => {
    const pppoeRepo   = new InMemoryPppoeServiceRepository();
    const nasRepo     = new InMemoryNasRepository();
    const orchestrator = new InMemoryRadiusOrchestratorGateway({
      usersInventory: [
        { username: 'OtroClienteUser', password: 'newpass', plan: 'IP-Fibra-50', framedIp: null },
      ],
    });
    const ingest = new IngestPppoeFromNas(pppoeRepo, nasRepo, orchestrator);

    await pppoeRepo.upsertByUsername({
      username:   'OtroClienteUser',
      password:   'originalpass',
      profile:    'IP-Fibra-50',
      remoteAddress: null,
      status:     'enabled',
      nasId:      NAS_RADIUS_ID,
      contractId: 'contract-99',
    });

    const result = await ingest.execute(NAS_RADIUS_ID);

    // El enabled fue skipeado → el contrato no se tocó
    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);

    const unchanged = await pppoeRepo.findByUsername('OtroClienteUser');
    expect(unchanged?.contractId).toBe('contract-99');
    expect(unchanged?.password).toBe('originalpass');
  });
});
