export interface FeatureFlag {
  key: string;
  enabled: boolean;
  updatedAt: string;
}

export interface FeatureFlagRepository {
  list(): Promise<FeatureFlag[]>;
  get(key: string): Promise<FeatureFlag | null>;
  setEnabled(key: string, enabled: boolean): Promise<FeatureFlag>;
}
