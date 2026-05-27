import { FeatureFlag, FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

export class ListFeatureFlags {
  constructor(private readonly repo: FeatureFlagRepository) {}

  async execute(): Promise<FeatureFlag[]> {
    return this.repo.list();
  }
}
