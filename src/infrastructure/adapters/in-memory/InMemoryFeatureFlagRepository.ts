import { FeatureFlag, FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';

export class InMemoryFeatureFlagRepository implements FeatureFlagRepository {
  private flags = new Map<string, FeatureFlag>();

  /** Test seam: pre-populate a flag without going through setEnabled. */
  seed(key: string, enabled: boolean): void {
    this.flags.set(key, { key, enabled, updatedAt: new Date().toISOString() });
  }

  async list(): Promise<FeatureFlag[]> {
    return [...this.flags.values()].map(f => ({ ...f }));
  }

  async get(key: string): Promise<FeatureFlag | null> {
    const flag = this.flags.get(key);
    return flag ? { ...flag } : null;
  }

  async setEnabled(key: string, enabled: boolean): Promise<FeatureFlag> {
    const updated: FeatureFlag = { key, enabled, updatedAt: new Date().toISOString() };
    this.flags.set(key, updated);
    return { ...updated };
  }
}
