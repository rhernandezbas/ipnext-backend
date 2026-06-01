import { SyncStateRepository } from '@domain/ports/SyncStateRepository';

/** SyncState entity key for the resumable contract backfill watermark. */
const BACKFILL_ENTITY = 'gr-contracts-backfill';

export interface ArmGrContractsBackfillResult {
  armed: true;
  offset: 0;
}

/**
 * Arms the `gr-contracts-backfill` watermark at offset 0 so subsequent scheduler
 * ticks drain the contract backfill from the start. Idempotent: arming over any
 * prior state (none / mid-offset / done) always lands at offset 0.
 */
export class ArmGrContractsBackfill {
  constructor(private readonly state: SyncStateRepository) {}

  async execute(): Promise<ArmGrContractsBackfillResult> {
    await this.state.save({
      entity: BACKFILL_ENTITY,
      cursor: '0',
      lastRunAt: null,
      lastResult: 'armed',
      itemsSynced: 0,
    });
    return { armed: true, offset: 0 };
  }
}
