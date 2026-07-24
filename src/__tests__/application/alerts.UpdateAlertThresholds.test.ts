import { UpdateAlertThresholds } from '@application/use-cases/alerts/UpdateAlertThresholds';
import { InMemoryNocAlertThresholdsConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertThresholdsConfigRepository';

describe('UpdateAlertThresholds', () => {
  it('replaces the singleton and returns the resulting DTO', async () => {
    const repo = new InMemoryNocAlertThresholdsConfigRepository();
    const useCase = new UpdateAlertThresholds(repo);

    const dto = await useCase.execute({ critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0 });

    expect(dto).toEqual({ critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0 });
    expect(await repo.get()).toEqual({ critDbm: -28, warnDbm: -25, deltaAlert: 1.5, ponMinAbon: 3, ponDelta: 1.0 });
  });
});
