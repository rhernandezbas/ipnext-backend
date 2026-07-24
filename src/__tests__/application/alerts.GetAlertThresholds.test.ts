import { GetAlertThresholds } from '@application/use-cases/alerts/GetAlertThresholds';
import { InMemoryNocAlertThresholdsConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertThresholdsConfigRepository';

describe('GetAlertThresholds', () => {
  it('returns the seeded defaults when nothing was edited yet', async () => {
    const repo = new InMemoryNocAlertThresholdsConfigRepository();
    const useCase = new GetAlertThresholds(repo);

    const dto = await useCase.execute();

    expect(dto).toEqual({ critDbm: -30, warnDbm: -27, deltaAlert: 2.0, ponMinAbon: 2, ponDelta: 1.5 });
  });

  it('reflects a prior update', async () => {
    const repo = new InMemoryNocAlertThresholdsConfigRepository();
    await repo.update({ critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0 });
    const useCase = new GetAlertThresholds(repo);

    const dto = await useCase.execute();

    expect(dto).toEqual({ critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0 });
  });
});
