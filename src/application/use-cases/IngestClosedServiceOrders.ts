import { IClassPort } from '@domain/ports/IClassPort';
import { IClassPortalPort } from '@domain/ports/IClassPortalPort';
import { correlateChecklistPhotos } from '@application/services/correlateChecklistPhotos';
import { ClosedServiceOrderRepository } from '@domain/ports/ClosedServiceOrderRepository';
import { IClassResultCodeRepository } from '@domain/ports/IClassResultCodeRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import {
  ClosedServiceOrder,
  ClosedServiceOrderSummary,
  SoStatusHistoryEntry,
} from '@domain/entities/iclass-closed-order';

/** SyncState key for this ingest (distinct from clients 'gr-clients'). */
const SYNC_ENTITY = 'iclass-closed';
/** Terminal status — the only state we mirror (ENCERRADO / Concluida). */
const TERMINAL_STATUS = '7';
/** IClass enforces a 30-day max window; stay safely under it on bootstrap. */
const BOOTSTRAP_DAYS = 25;
/** Overlap re-scanned each steady-state run (approval flips 4→50→7 days later). */
const DEFAULT_OVERLAP_MINUTES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface IngestClosedCounts {
  /** SOs upserted into the mirror. */
  mirrored: number;
  /** Tasks moved to a mapped stage. */
  transitioned: number;
  /** SOs whose status is not terminal ('7'). */
  skippedNotClosed: number;
  /** SOs with no matching local task (codigo is the iclass id, not our sequenceNumber). */
  skippedNotOurs: number;
  /** SOs already mirrored at the same iclassUpdatedAt (idempotent no-op). */
  skippedUnchanged: number;
}

export interface IngestClosedOptions {
  now?: () => Date;
  overlapMinutes?: number;
  /**
   * Optional SEAM portal scraper. When present, each mirrored SO's checklist
   * photos are correlated by ordem from the portal HTML (API v2 is photo-blind).
   * Absent → photoUrl stays null (no behavior change). Opt-in, like the config.
   */
  portal?: IClassPortalPort;
}

/**
 * Closure loop: pull closed IClass SOs back, mirror the ones that match a local
 * task (by codigo↔sequenceNumber), and move each matched task to the Stage the
 * operator mapped to its result code. Idempotent by iclassUpdatedAt.
 */
export class IngestClosedServiceOrders {
  private readonly now: () => Date;
  private readonly overlapMinutes: number;
  private readonly portal?: IClassPortalPort;

  constructor(
    private readonly iclass: IClassPort,
    private readonly closed: ClosedServiceOrderRepository,
    private readonly resultCodes: IClassResultCodeRepository,
    private readonly scheduling: SchedulingRepository,
    private readonly state: SyncStateRepository,
    opts: IngestClosedOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.overlapMinutes = opts.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES;
    this.portal = opts.portal;
  }

  async execute(): Promise<IngestClosedCounts> {
    const counts = newCounts();
    const now = this.now();

    try {
      const prior = await this.state.get(SYNC_ENTITY);
      const windowBegin = this.resolveWindowBegin(prior?.cursor ?? null, now);

      const summaries = await this.iclass.listServiceOrders({
        updatedDateBegin: windowBegin,
        updatedDateEnd: now,
      });

      for (const s of summaries) {
        await this.processSummary(s, counts);
      }
    } catch (err) {
      await this.state.save({
        entity: SYNC_ENTITY,
        cursor: null,
        lastRunAt: now,
        lastResult: `error: ${(err as Error).message}`,
        itemsSynced: counts.mirrored,
      });
      throw err;
    }

    await this.state.save({
      entity: SYNC_ENTITY,
      cursor: now.toISOString(),
      lastRunAt: now,
      lastResult: JSON.stringify(counts),
      itemsSynced: counts.mirrored,
    });
    return counts;
  }

  /**
   * Process one SO summary: filter terminal + ours, idempotency-gate, fetch
   * children, assemble the aggregate, mirror it, and transition the task per the
   * configured result-code → stage mapping. Public so the backfill can reuse it.
   */
  async processSummary(s: ClosedServiceOrderSummary, counts: IngestClosedCounts): Promise<void> {
    if (s.statusCode !== TERMINAL_STATUS) {
      counts.skippedNotClosed++;
      return;
    }

    // Join to our work: SO.codigo == ScheduledTask.sequenceNumber. SOs created
    // directly in IClass carry codigo == iclass id (huge / non-our-range) and have
    // no matching task → not ours.
    const seq = Number(s.iclassCodigo);
    const task = Number.isInteger(seq) ? await this.scheduling.findTaskBySequenceNumber(seq) : null;
    if (!task) {
      counts.skippedNotOurs++;
      return;
    }

    // Idempotency — skip if already mirrored at the same modification timestamp.
    const existing = await this.closed.findSyncStateByIclassId(s.iclassId);
    if (existing && existing.iclassUpdatedAt === s.iclassUpdatedAt) {
      counts.skippedUnchanged++;
      return;
    }

    // Fan out to sub-resources (the adapter applies backoff between calls).
    const history = await this.iclass.getServiceOrderHistory(s.iclassId);
    let checklists = await this.iclass.getServiceOrderChecklists(s.iclassId);
    const materials = await this.iclass.getServiceOrderMaterials(s.iclassId);
    const equipmentEvents = await this.iclass.getServiceOrderEquipmentEvents(s.iclassId);

    // Correlate checklist photos from the SEAM portal (opt-in). The API is
    // photo-blind; a portal failure (down / rate-limited) must NOT break the
    // mirror — photoUrl stays null and is retried on the next cycle (SCEN-CO-3).
    if (this.portal) {
      try {
        const scraped = await this.portal.getOSDetail(String(s.iclassId));
        checklists = correlateChecklistPhotos(checklists, scraped);
      } catch {
        /* keep the mirror; photos retried next run */
      }
    }

    // Resolve the configured closure mapping by result-code name.
    const rc = s.resultCodeName ? await this.resultCodes.findByCode(s.resultCodeName) : null;

    const order: ClosedServiceOrder = {
      ...s,
      closedAt: latestTransition(history, '7'),
      firstClosedAt: latestTransition(history, '4'),
      approvedAt: latestTransition(history, '50'),
      resultCodeType: rc?.type ?? null,
      history,
      checklists,
      materials,
      equipmentEvents,
    };

    await this.closed.upsert(order, task.id);
    counts.mirrored++;

    // Move the task only when the operator mapped this result code to a stage.
    if (rc?.mappedStageId) {
      await this.scheduling.moveTaskToStage(task.id, rc.mappedStageId);
      counts.transitioned++;
    }
  }

  private resolveWindowBegin(cursor: string | null, now: Date): Date {
    let begin = cursor
      ? new Date(new Date(cursor).getTime() - this.overlapMinutes * 60_000)
      : new Date(now.getTime() - BOOTSTRAP_DAYS * DAY_MS);
    // Clamp under the API's 30-day window cap.
    const earliest = new Date(now.getTime() - 29 * DAY_MS);
    if (begin.getTime() < earliest.getTime()) begin = earliest;
    return begin;
  }
}

/** Fresh zeroed counts — exported so the backfill can accumulate into one tally. */
export function emptyClosedCounts(): IngestClosedCounts {
  return { mirrored: 0, transitioned: 0, skippedNotClosed: 0, skippedNotOurs: 0, skippedUnchanged: 0 };
}

function newCounts(): IngestClosedCounts {
  return emptyClosedCounts();
}

/** Most-recent occurredAt among history entries with the given status code, or null. */
function latestTransition(history: SoStatusHistoryEntry[], statusCode: string): string | null {
  const times = history
    .filter(h => h.statusCode === statusCode && h.occurredAt)
    .map(h => h.occurredAt as string)
    .sort();
  return times.length ? times[times.length - 1] : null;
}
