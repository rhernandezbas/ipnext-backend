import { SyncStateRepository, SyncState } from '@domain/ports/SyncStateRepository';

const SYNC_ENTITY = 'gr-clients';

export interface SyncStatusView {
  entity: string;
  cursor: string | null;
  lastRunAt: Date | null;
  lastResult: string | null;
  itemsSynced: number;
  /** false until the first run has persisted state. */
  hasRun: boolean;
}

/** Read-only view of the GR mirror sync state, for the "réplica viva" header. */
export class GetGestionRealSyncStatus {
  constructor(private readonly state: SyncStateRepository) {}

  async execute(): Promise<SyncStatusView> {
    const s: SyncState | null = await this.state.get(SYNC_ENTITY);
    if (!s) {
      return { entity: SYNC_ENTITY, cursor: null, lastRunAt: null, lastResult: null, itemsSynced: 0, hasRun: false };
    }
    return { ...s, hasRun: true };
  }
}
