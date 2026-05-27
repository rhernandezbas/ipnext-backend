import { FeatureFlag, FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { FeatureFlagNotFoundError } from '@domain/errors/featureFlags';

export class GetFeatureFlag {
  constructor(private readonly repo: FeatureFlagRepository) {}

  async execute(key: string): Promise<FeatureFlag> {
    const flag = await this.repo.get(key);
    if (!flag) throw new FeatureFlagNotFoundError(key);
    return flag;
  }
}
