import { ClientMirrorReadRepository } from '@domain/ports/ClientMirrorReadRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { SyncGestionRealContracts } from './SyncGestionRealContracts';

/** SyncState entity key for the resumable contract backfill watermark. */
const BACKFILL_ENTITY = 'gr-contracts-backfill';

export interface BackfillBatchResult {
  /** ids handled this batch (≤ batchSize). */
  processed: number;
  /** contracts fetched from GR this batch. */
  fetched: number;
  created: number;
  updated: number;
  /** persisted watermark offset after this batch. */
  nextOffset: number;
  /** true when the universe is fully covered (disarmed). */
  done: boolean;
}

/**
 * Resumable, bounded contract backfill. Iterates the LOCAL GR client universe
 * (independent of GR's modification feed) one fixed-size slice per call, driven
 * by an offset watermark stored in the `gr-contracts-backfill` SyncState row.
 *
 * - Bounded: at most `batchSize` ids per call → ≤ batchSize GR calls, then returns.
 * - Resumable: all progress lives in SyncState; a fresh instance over the same
 *   repo reads the same offset (survives container restarts).
 * - Idempotent / at-least-once: the watermark advances only AFTER the batch's
 *   upserts complete; a crash mid-batch re-runs that batch next time and
 *   `upsertContract` (keyed by grContratoId) makes re-processing harmless.
 * - No-op when disarmed (no row / cursor null).
 *
 * Reuses `SyncGestionRealContracts` as the per-id fetch+upsert collaborator so
 * there is one contract-fetch path.
 */
export class BackfillGrContractsBatch {
  constructor(
    private readonly mirrorRead: ClientMirrorReadRepository,
    private readonly syncContracts: SyncGestionRealContracts,
    private readonly state: SyncStateRepository,
    private readonly batchSize = 150,
  ) {}

  async execute(): Promise<BackfillBatchResult> {
    const prior = await this.state.get(BACKFILL_ENTITY);
    if (!prior || prior.cursor === null) {
      // Disarmed / done → no-op.
      return { processed: 0, fetched: 0, created: 0, updated: 0, nextOffset: 0, done: true };
    }

    const offset = Number(prior.cursor) || 0;
    // Sort IN the use case so order is deterministic regardless of repo/DB ordering.
    const ids = (await this.mirrorRead.listGrClienteIds()).slice().sort();
    const total = ids.length;

    if (offset >= total) {
      // Universe shrank to/below the offset → mark done, disarm.
      await this.state.save({
        entity: BACKFILL_ENTITY,
        cursor: null,
        lastRunAt: new Date(),
        lastResult: 'done',
        itemsSynced: prior.itemsSynced ?? 0,
      });
      return { processed: 0, fetched: 0, created: 0, updated: 0, nextOffset: offset, done: true };
    }

    const slice = ids.slice(offset, offset + this.batchSize);
    const r = await this.syncContracts.execute(slice);
    const nextOffset = offset + slice.length;
    const done = nextOffset >= total;

    await this.state.save({
      entity: BACKFILL_ENTITY,
      cursor: done ? null : String(nextOffset),
      lastRunAt: new Date(),
      lastResult: done ? 'done' : `batch ok @${nextOffset}`,
      itemsSynced: (prior.itemsSynced ?? 0) + slice.length,
    });

    return {
      processed: slice.length,
      fetched: r.fetched,
      created: r.created,
      updated: r.updated,
      nextOffset,
      done,
    };
  }
}
