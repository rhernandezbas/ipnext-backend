import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { ClosureStatusDTO, ClosureRunCounts } from '@application/dto/iclassClosure.dto';

const SYNC_ENTITY = 'iclass-closed';

const ZERO: ClosureRunCounts = {
  mirrored: 0,
  transitioned: 0,
  skippedNotClosed: 0,
  skippedNotOurs: 0,
  skippedUnchanged: 0,
};

/** Read the last closure-ingest run status from SyncState ('iclass-closed'). */
export class GetClosureStatus {
  constructor(private readonly state: SyncStateRepository) {}

  async execute(): Promise<ClosureStatusDTO> {
    const s = await this.state.get(SYNC_ENTITY);
    if (!s) return { lastRunAt: null, counts: { ...ZERO } };

    let counts: ClosureRunCounts = { ...ZERO };
    if (s.lastResult) {
      try {
        const p = JSON.parse(s.lastResult) as Partial<ClosureRunCounts>;
        counts = {
          mirrored: p.mirrored ?? 0,
          transitioned: p.transitioned ?? 0,
          skippedNotClosed: p.skippedNotClosed ?? 0,
          skippedNotOurs: p.skippedNotOurs ?? 0,
          skippedUnchanged: p.skippedUnchanged ?? 0,
        };
      } catch {
        // lastResult was an "error: ..." string → keep zeros.
      }
    }

    return { lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null, counts };
  }
}
