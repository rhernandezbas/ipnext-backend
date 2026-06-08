import { IClassPort } from '@domain/ports/IClassPort';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import {
  IngestClosedServiceOrders,
  IngestClosedCounts,
  emptyClosedCounts,
} from './IngestClosedServiceOrders';

/** Immutable business code for the stage holding tasks sent to IClass and awaiting closure. */
const DEFAULT_IN_FLIGHT_STAGE_CODE = 'registered_in_iclass';
/** Single-window lookback per task. IClass caps the window at 30 days; in-flight
 * tasks are recent so this covers the realistic case. Closures older than ~30
 * days on a still-in-flight task are rare (a stuck task) and need a manual reconcile. */
const DEFAULT_LOOKBACK_DAYS = 29;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Pausa entre tareas para no saturar la API de IClass (~78 tareas en vuelo típico). */
const DEFAULT_THROTTLE_MS = 350;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export interface BackfillOptions {
  now?: () => Date;
  /** Immutable business code of the stage holding in-flight (sent, awaiting closure) tasks. */
  inFlightStageCode?: string;
  /** How far back to look for each task's closure (clamped to 29 by the IClass cap). */
  lookbackDays?: number;
  /** Pausa en ms entre tareas (default 350ms). Pasar 0 en tests para no incurrir en waits reales. */
  throttleMs?: number;
  /** Función sleep inyectable para tests sin delays reales. */
  _sleep?: (ms: number) => Promise<void>;
}

/**
 * Scoped backfill of the closure loop: reconcile the tasks we already sent to
 * IClass. For each task sitting in the in-flight stage, query IClass by its exact
 * serviceOrderCode (= sequenceNumber) and run the SAME processing as the steady
 * poll (reuses IngestClosedServiceOrders.processSummary). Idempotent.
 */
export class BackfillClosedServiceOrders {
  private readonly now: () => Date;
  private readonly inFlightStageCode: string;
  private readonly lookbackDays: number;
  private readonly throttleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly iclass: IClassPort,
    private readonly scheduling: SchedulingRepository,
    private readonly ingest: IngestClosedServiceOrders,
    opts: BackfillOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.inFlightStageCode = opts.inFlightStageCode ?? DEFAULT_IN_FLIGHT_STAGE_CODE;
    this.lookbackDays = Math.min(opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 29);
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.sleep = opts._sleep ?? sleep;
  }

  async execute(): Promise<IngestClosedCounts> {
    const counts = emptyClosedCounts();
    const now = this.now();
    const begin = new Date(now.getTime() - this.lookbackDays * DAY_MS);

    const tasks = await this.scheduling.listTasksInIClassStage(this.inFlightStageCode);
    for (const task of tasks) {
      try {
        const summaries = await this.iclass.listServiceOrders({
          updatedDateBegin: begin,
          updatedDateEnd: now,
          serviceOrderCode: String(task.sequenceNumber),
        });
        for (const s of summaries) {
          await this.ingest.processSummary(s, counts);
        }
      } catch {
        // Un fallo en la tarea no aborta el batch — se incrementa el contador y se continúa.
        counts.failed++;
      }
      await this.sleep(this.throttleMs);
    }
    return counts;
  }
}
