import { FeatureFlag, FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { FeatureFlagNotFoundError } from '@domain/errors/featureFlags';

export class SetFeatureFlag {
  constructor(private readonly repo: FeatureFlagRepository) {}

  async execute(key: string, enabled: boolean): Promise<FeatureFlag> {
    const existing = await this.repo.get(key);
    if (!existing) throw new FeatureFlagNotFoundError(key);
    return this.repo.setEnabled(key, enabled);
  }
}
