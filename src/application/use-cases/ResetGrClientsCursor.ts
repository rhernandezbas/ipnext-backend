import { SyncStateRepository } from '@domain/ports/SyncStateRepository';

const SYNC_ENTITY = 'gr-clients';

export interface ResetGrClientsCursorResult {
  entity: typeof SYNC_ENTITY;
  cursor: null;
}

/**
 * Clears the gr-clients sync watermark so the scheduler runs a full backfill
 * on its next tick. SyncGestionRealClients picks mode by `prior?.cursor`:
 * a null cursor → backfill (re-downloads every client, re-applying the fixed
 * phone parser). Safe no-op when no prior state exists.
 */
export class ResetGrClientsCursor {
  constructor(private readonly state: SyncStateRepository) {}

  async execute(): Promise<ResetGrClientsCursorResult> {
    const prior = await this.state.get(SYNC_ENTITY);
    await this.state.save({
      entity: SYNC_ENTITY,
      cursor: null,
      lastRunAt: prior?.lastRunAt ?? null,
      lastResult: 'cursor reset for backfill',
      itemsSynced: prior?.itemsSynced ?? 0,
    });
    return { entity: SYNC_ENTITY, cursor: null };
  }
}
