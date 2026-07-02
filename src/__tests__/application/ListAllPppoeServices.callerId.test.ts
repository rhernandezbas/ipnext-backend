/**
 * ListAllPppoeServices.callerId.test.ts
 * TDD (task 1.5): callerId exposed in PppoeServiceListItemDto + no password.
 */
import { ListAllPppoeServices } from '@application/use-cases/ListAllPppoeServices';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';

async function buildUseCase() {
  const pppoeRepo = new InMemoryPppoeServiceRepository();
  const eventRepo = new InMemoryContractServiceEventRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  const useCase = new ListAllPppoeServices(pppoeRepo, eventRepo, catalogRepo);
  return { useCase, pppoeRepo };
}

describe('ListAllPppoeServices — callerId in DTO', () => {
  it('item includes callerId when the service has one', async () => {
    const { useCase, pppoeRepo } = await buildUseCase();
    const s = await pppoeRepo.upsertByUsername({
      username: 'user@test',
      password: 'secret',
      profile: 'IP-30M',
      nasId: '1',
      contractId: 'ctr-1',
      status: 'enabled',
    });
    // Manually set callerId
    await pppoeRepo.setCallerId(s.id, 'AA:BB:CC:DD:EE:FF');

    const result = await useCase.execute({ page: 1, limit: 25 });
    expect(result.data).toHaveLength(1);
    const item = result.data[0]!;
    expect(item.callerId).toBe('AA:BB:CC:DD:EE:FF');
    expect(item).not.toHaveProperty('password');
  });

  it('item has callerId=null when the service has no callerId', async () => {
    const { useCase, pppoeRepo } = await buildUseCase();
    await pppoeRepo.upsertByUsername({
      username: 'noCallerId@test',
      password: 'secret',
      profile: 'IP-30M',
      nasId: '1',
      contractId: 'ctr-2',
      status: 'enabled',
    });

    const result = await useCase.execute({ page: 1, limit: 25 });
    expect(result.data).toHaveLength(1);
    const item = result.data[0]!;
    expect(item.callerId).toBeNull();
    expect(item).not.toHaveProperty('password');
  });
});
