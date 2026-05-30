import { UpdateSyncConfig } from '@application/use-cases/UpdateSyncConfig';
import { InMemoryGestionRealSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealSyncConfigRepository';

describe('UpdateSyncConfig', () => {
  it('update({ intervalMs }) returns the updated DTO, estados untouched (REQ-PUTCFG-1)', async () => {
    const repo = new InMemoryGestionRealSyncConfigRepository();
    const useCase = new UpdateSyncConfig(repo);

    const dto = await useCase.execute({ intervalMs: 300000 });

    expect(dto).toEqual({ intervalMs: 300000, estados: ['1', '2', '3', '4', '6'] });
  });

  it('update({ estados }) replaces the set (not merge)', async () => {
    const repo = new InMemoryGestionRealSyncConfigRepository();
    const useCase = new UpdateSyncConfig(repo);

    const dto = await useCase.execute({ estados: ['1', '6'] });

    expect(dto.estados).toEqual(['1', '6']);
    expect(dto.intervalMs).toBe(180000);

    const reread = await useCase.execute({});
    expect(reread.estados).toEqual(['1', '6']);
  });
});
