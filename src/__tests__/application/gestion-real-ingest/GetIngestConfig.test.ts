import { GetIngestConfig } from '@application/use-cases/GetIngestConfig';
import { InMemoryGestionRealIngestConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGestionRealIngestConfigRepository';

describe('GetIngestConfig', () => {
  it('returns the current config as a DTO (REQ-GETCFG-1)', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();
    await repo.update({
      intervalMs: 180000,
      fiberProjectId: 'p-fiber',
      wirelessProjectId: 'p-wifi',
      windowMonths: 12,
    });
    const useCase = new GetIngestConfig(repo);

    const dto = await useCase.execute();

    expect(dto).toEqual({
      intervalMs: 180000,
      windowMonths: 12,
      fiberProjectId: 'p-fiber',
      wirelessProjectId: 'p-wifi',
      sourceEstado: 'CONF',
      pppoeProfile: null,
    });
  });

  it('K1: exposes the configured pppoeProfile in the DTO', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();
    await repo.update({ pppoeProfile: 'IP-Air-30-10' });
    const useCase = new GetIngestConfig(repo);

    const dto = await useCase.execute();

    expect(dto.pppoeProfile).toBe('IP-Air-30-10');
  });

  it('returns defaults before any config is set', async () => {
    const repo = new InMemoryGestionRealIngestConfigRepository();
    const useCase = new GetIngestConfig(repo);

    const dto = await useCase.execute();

    expect(dto).toEqual({
      intervalMs: 180000,
      windowMonths: 12,
      fiberProjectId: null,
      wirelessProjectId: null,
      sourceEstado: 'CONF',
      pppoeProfile: null,
    });
  });
});
