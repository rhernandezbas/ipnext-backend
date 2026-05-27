import { SyncStateRepository, SyncState } from '@domain/ports/SyncStateRepository';
import { MirrorCountsRepository } from '@domain/ports/MirrorCountsRepository';

const SYNC_ENTITY = 'gr-clients';

export interface SyncStatusView {
  entity: string;
  cursor: string | null;
  lastRunAt: Date | null;
  lastResult: string | null;
  itemsSynced: number;
  /** false until the first run has persisted state. */
  hasRun: boolean;
  /** Number of Client rows mirrored from Gestión Real. */
  clientCount: number;
  /** Number of Service rows mirrored from Gestión Real. */
  contractCount: number;
}

/** Read-only view of the GR mirror sync state, for the "réplica viva" header. */
export class GetGestionRealSyncStatus {
  constructor(
    private readonly state: SyncStateRepository,
    private readonly counts: MirrorCountsRepository,
  ) {}

  async execute(): Promise<SyncStatusView> {
    const [s, clientCount, contractCount] = await Promise.all([
      this.state.get(SYNC_ENTITY),
      this.counts.clientCount(),
      this.counts.contractCount(),
    ]);

    if (!s) {
      return {
        entity: SYNC_ENTITY,
        cursor: null,
        lastRunAt: null,
        lastResult: null,
        itemsSynced: 0,
        hasRun: false,
        clientCount,
        contractCount,
      };
    }

    return { ...s, hasRun: true, clientCount, contractCount };
  }
}
