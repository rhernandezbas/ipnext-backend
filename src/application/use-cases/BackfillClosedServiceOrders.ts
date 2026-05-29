import { IClassPort } from '@domain/ports/IClassPort';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import {
  IngestClosedServiceOrders,
  IngestClosedCounts,
  emptyClosedCounts,
} from './IngestClosedServiceOrders';

/** Stage that holds tasks already sent to IClass and awaiting closure. */
const DEFAULT_IN_FLIGHT_STAGE = 'Registrado en IClass';
/** Single-window lookback per task. IClass caps the window at 30 days; in-flight
 * tasks are recent so this covers the realistic case. Closures older than ~30
 * days on a still-in-flight task are rare (a stuck task) and need a manual reconcile. */
const DEFAULT_LOOKBACK_DAYS = 29;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackfillOptions {
  now?: () => Date;
  /** Stage name holding in-flight (sent, awaiting closure) tasks. */
  inFlightStageName?: string;
  /** How far back to look for each task's closure (clamped to 29 by the IClass cap). */
  lookbackDays?: number;
}

/**
 * Scoped backfill of the closure loop: reconcile the tasks we already sent to
 * IClass. For each task sitting in the in-flight stage, query IClass by its exact
 * serviceOrderCode (= sequenceNumber) and run the SAME processing as the steady
 * poll (reuses IngestClosedServiceOrders.processSummary). Idempotent.
 */
export class BackfillClosedServiceOrders {
  private readonly now: () => Date;
  private readonly inFlightStageName: string;
  private readonly lookbackDays: number;

  constructor(
    private readonly iclass: IClassPort,
    private readonly scheduling: SchedulingRepository,
    private readonly ingest: IngestClosedServiceOrders,
    opts: BackfillOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.inFlightStageName = opts.inFlightStageName ?? DEFAULT_IN_FLIGHT_STAGE;
    this.lookbackDays = Math.min(opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 29);
  }

  async execute(): Promise<IngestClosedCounts> {
    const counts = emptyClosedCounts();
    const now = this.now();
    const begin = new Date(now.getTime() - this.lookbackDays * DAY_MS);

    const tasks = await this.scheduling.listTasksInIClassStage(this.inFlightStageName);
    for (const task of tasks) {
      const summaries = await this.iclass.listServiceOrders({
        updatedDateBegin: begin,
        updatedDateEnd: now,
        serviceOrderCode: String(task.sequenceNumber),
      });
      for (const s of summaries) {
        await this.ingest.processSummary(s, counts);
      }
    }
    return counts;
  }
}
