/**
 * Single-row Gigared config (#47). Pattern: GestionRealSyncConfigRepository.
 * `get()` returns defaults (apiKey '') before any row is persisted. An empty apiKey
 * means unconfigured. The full apiKey NEVER leaves the API — masking happens in the use case.
 */
export interface GigaredConfig {
  apiKey: string;
  baseUrl: string;
  updatedAt: string;
}

export interface GigaredConfigRepository {
  /** Current config; returns defaults (apiKey '') if no row has been persisted yet. */
  get(): Promise<GigaredConfig>;
  /** Apply a partial patch (apiKey/baseUrl) and return the resulting full config. */
  update(patch: Partial<Pick<GigaredConfig, 'apiKey' | 'baseUrl'>>): Promise<GigaredConfig>;
}
