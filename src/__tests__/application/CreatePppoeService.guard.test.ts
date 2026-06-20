/**
 * CreatePppoeService — guard #4 (contrato con PPPoE enabled ya asociado).
 *
 * TDD: escrito ANTES de la implementación.
 */
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { PppoeContractAlreadyHasServiceError } from '@domain/errors/pppoe';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { InMemoryContractServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

describe('CreatePppoeService — guard #4 (contrato ocupado)', () => {
  let repo: InMemoryPppoeServiceRepository;
  let uc: CreatePppoeService;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
    const csRepo = new InMemoryContractServiceRepository();
    const catalogRepo = new InMemoryServiceCatalogRepository();
    const ensure = new EnsureInternetContractService(csRepo, catalogRepo);
    uc = new CreatePppoeService(
      repo,
      new InMemoryRouterGateway(),
      new InMemoryNasRepository(),
      new InMemoryRadiusOrchestratorGateway(),
      ensure,
    );
  });

  it('contractId ocupado (enabled) → PppoeContractAlreadyHasServiceError', async () => {
    // Contrato C1 ya tiene un PPPoE enabled
    await repo.upsertByUsername({ username: 'existente', password: 'p', nasId: '1', contractId: 'C1', status: 'enabled' });

    await expect(
      uc.execute({ contractId: 'C1', username: 'nuevo', password: 'pw', nasId: '1' }),
    ).rejects.toBeInstanceOf(PppoeContractAlreadyHasServiceError);
  });

  it('contractId ocupado (disabled) → NO bloquea (un disabled no ocupa el slot)', async () => {
    await repo.upsertByUsername({ username: 'baja', password: 'p', nasId: '1', contractId: 'C1', status: 'disabled' });
    // Debe pasar sin error (el router no va a fallar en in-memory)
    const result = await uc.execute({ contractId: 'C1', username: 'nuevo', password: 'pw', nasId: '1' });
    expect(result.status).toBe('enabled');
    expect(result.contractId).toBe('C1');
  });

  it('contractId=null → no aplica el guard (PPPoE huérfano)', async () => {
    const result = await uc.execute({ contractId: null, username: 'orphan', password: 'pw', nasId: '1' });
    expect(result.contractId).toBeNull();
  });
});
