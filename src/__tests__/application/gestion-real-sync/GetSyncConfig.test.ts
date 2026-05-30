import { GetSyncConfig } from '@application/use-cases/GetSyncConfig';
import { InMemoryGestionRealSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealSyncConfigRepository';

describe('GetSyncConfig', () => {
  it('returns the current config as a DTO (REQ-GETCFG-1)', async () => {
    const repo = new InMemoryGestionRealSyncConfigRepository();
    await repo.update({ intervalMs: 300000, estados: ['1', '3', '6'] });
    const useCase = new GetSyncConfig(repo);

    const dto = await useCase.execute();

    expect(dto).toEqual({ intervalMs: 300000, estados: ['1', '3', '6'] });
  });

  it('returns defaults before any config is set', async () => {
    const repo = new InMemoryGestionRealSyncConfigRepository();
    const useCase = new GetSyncConfig(repo);

    const dto = await useCase.execute();

    expect(dto).toEqual({ intervalMs: 180000, estados: ['1', '2', '3', '4', '6'] });
  });
});
