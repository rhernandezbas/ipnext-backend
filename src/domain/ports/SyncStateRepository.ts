export interface SyncState {
  /** Logical entity key, e.g. "gr-clients". */
  entity: string;
  /**
   * Watermark for the next delta. For GR clients this is the date (DD-MM-AAAA)
   * of the last successful run; null means "never synced → backfill".
   */
  cursor: string | null;
  lastRunAt: Date | null;
  /** "ok" or "error: <message>". */
  lastResult: string | null;
  /** Cumulative rows touched on the last run. */
  itemsSynced: number;
}

export interface SyncStateRepository {
  get(entity: string): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}
