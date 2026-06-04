import { IClassPort } from '@domain/ports/IClassPort';
import { IClassPortalPort } from '@domain/ports/IClassPortalPort';
import { correlateChecklistPhotos } from '@application/services/correlateChecklistPhotos';
import { classifyDeviceType, isSnMacDevicePhoto } from '@application/services/classifyDeviceType';
import { dedupeStatusHistory } from '@application/services/dedupeStatusHistory';
import { PostClosureComment } from '@application/use-cases/PostClosureComment';
import { ExtractDeviceInfoFromPhoto } from '@application/use-cases/ExtractDeviceInfoFromPhoto';
import { BuildInventorySuggestions } from '@application/use-cases/BuildInventorySuggestions';
import { AuditInstallationQuality } from '@application/use-cases/AuditInstallationQuality';
import { ScrapedOSDetail } from '@domain/entities/iclass-portal';
import { OcrExtraction } from '@domain/entities/ocr-extraction';
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
  /** SOs whose processing threw — logged and skipped so one bad SO never aborts the batch. */
  errored: number;
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
  /** Optional closure-loop side effects (all opt-in, all non-fatal). */
  postComment?: PostClosureComment;
  extractOcr?: ExtractDeviceInfoFromPhoto;
  buildSuggestions?: BuildInventorySuggestions;
  /** F6 — AI installation audit (closure side-effect, opt-in, non-fatal). */
  auditInstallation?: AuditInstallationQuality;
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
  private readonly postComment?: PostClosureComment;
  private readonly extractOcr?: ExtractDeviceInfoFromPhoto;
  private readonly buildSuggestions?: BuildInventorySuggestions;
  private readonly auditInstallation?: AuditInstallationQuality;

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
    this.postComment = opts.postComment;
    this.extractOcr = opts.extractOcr;
    this.buildSuggestions = opts.buildSuggestions;
    this.auditInstallation = opts.auditInstallation;
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
        // Isolate per-SO failures: one bad SO is logged + counted, never aborts
        // the batch (which would also stall the watermark and re-hit it forever).
        try {
          await this.processSummary(s, counts);
        } catch (e) {
          counts.errored++;
          console.error(`[iclass-closed] SO ${s.iclassId} (codigo ${s.iclassCodigo}) failed: ${(e as Error).message}`);
        }
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
    const history = dedupeStatusHistory(await this.iclass.getServiceOrderHistory(s.iclassId));
    let checklists = await this.iclass.getServiceOrderChecklists(s.iclassId);
    const materials = await this.iclass.getServiceOrderMaterials(s.iclassId);
    const equipmentEvents = await this.iclass.getServiceOrderEquipmentEvents(s.iclassId);

    // Correlate checklist photos from the SEAM portal (opt-in). The API is
    // photo-blind; a portal failure (down / rate-limited) must NOT break the
    // mirror — photoUrl stays null and is retried on the next cycle (SCEN-CO-3).
    let scraped: ScrapedOSDetail | null = null;
    if (this.portal) {
      try {
        scraped = await this.portal.getOSDetail(String(s.iclassId));
        checklists = correlateChecklistPhotos(checklists, scraped);
      } catch {
        scraped = null; // keep the mirror; photos retried next run
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

    await this.orchestrateClosure(order, task.id, scraped);
  }

  /**
   * Closure side effects (all opt-in, all non-fatal — a failure here never
   * affects the mirror/transition already committed): OCR the SN/MAC device
   * photos, build inventory suggestions (staging), and post the readable comment.
   */
  private async orchestrateClosure(
    order: ClosedServiceOrder,
    taskId: string,
    scraped: ScrapedOSDetail | null,
  ): Promise<void> {
    const extractions: OcrExtraction[] = [];
    if (this.extractOcr) {
      for (const checklist of order.checklists) {
        for (const a of checklist.answers) {
          if (a.questionType === 'Foto' && a.photoUrl && isSnMacDevicePhoto(a.questionText)) {
            try {
              extractions.push(
                await this.extractOcr.execute({
                  photoUrl: a.photoUrl,
                  deviceType: classifyDeviceType(a.questionText),
                  serviceOrderId: order.iclassId,
                  sourceTaskId: taskId,
                }),
              );
            } catch {
              /* skip this photo */
            }
          }
        }
      }
    }

    if (this.buildSuggestions) {
      try {
        await this.buildSuggestions.execute({ taskId, extractions, materials: order.materials });
      } catch {
        /* non-fatal */
      }
    }

    if (this.postComment) {
      try {
        const attachmentUrls = (scraped?.attachments ?? []).map(a => a.url);
        await this.postComment.execute({ taskId, order, attachmentUrls });
      } catch {
        /* non-fatal */
      }
    }

    if (this.auditInstallation) {
      try {
        await this.auditInstallation.execute({ taskId, order });
      } catch (err) {
        // non-fatal — la auditoría IA nunca afecta el cierre ya commiteado, pero LOGUEAMOS el fallo
        // eslint-disable-next-line no-console
        console.error(`[audit] task ${taskId}: side-effect lanzó (no deberia, audit() never throws):`, err instanceof Error ? err.message : err);
      }
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
  return { mirrored: 0, transitioned: 0, skippedNotClosed: 0, skippedNotOurs: 0, skippedUnchanged: 0, errored: 0 };
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
