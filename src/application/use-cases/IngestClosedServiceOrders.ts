import { IClassPort } from '@domain/ports/IClassPort';
import { IClassPortalPort } from '@domain/ports/IClassPortalPort';
import { IClassStatusCatalogRepository } from '@domain/ports/IClassStatusCatalogRepository';
// FIX 2 — int4-overflow guard: reuse the shared constant (sequenceNumber is Int/int4 in schema).
// Importing from the infrastructure helper is intentional — INT4_MAX is a pure constant with
// no runtime infrastructure dependency. The alternative (hardcoding the value) was explicitly
// rejected in the review.
import { INT4_MAX } from '@infrastructure/adapters/search/sequenceNumberClause';
import { correlateChecklistPhotos } from '@application/services/correlateChecklistPhotos';
import { classifyDeviceType, isSnMacDevicePhoto } from '@application/services/classifyDeviceType';
import { dedupeStatusHistory } from '@application/services/dedupeStatusHistory';
import { PostClosureComment } from '@application/use-cases/PostClosureComment';
import { ExtractDeviceInfoFromPhoto } from '@application/use-cases/ExtractDeviceInfoFromPhoto';
import { BuildInventorySuggestions } from '@application/use-cases/BuildInventorySuggestions';
import { AuditInstallationQuality } from '@application/use-cases/AuditInstallationQuality';
import { StageReturnSuggestions } from '@application/use-cases/StageReturnSuggestions';
import { ScrapedOSDetail } from '@domain/entities/iclass-portal';
import { OcrExtraction } from '@domain/entities/ocr-extraction';
import { ClosedServiceOrderRepository } from '@domain/ports/ClosedServiceOrderRepository';
import { IClassResultCodeRepository } from '@domain/ports/IClassResultCodeRepository';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { InventorySuggestionRepository } from '@domain/ports/InventorySuggestionRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { TaskActivityRecorder } from '@domain/ports/TaskActivityRecorder';
import { SYSTEM_ACTOR } from './taskActivityActor';
import { applyTaskClosure } from './applyTaskClosure';
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
/** Stage holding tasks sent to IClass and awaiting closure (rename-safe, by code). */
const DEFAULT_IN_FLIGHT_STAGE_CODE = 'registered_in_iclass';
/** Max audit attempts before giving up (so a broken model never hammers Ollama). */
const DEFAULT_MAX_AUDIT_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** EPIC #38 W4 — runtime feature flag gating the closure-detected returns side-effect (default OFF). */
export const ICLASS_RETURNS_FLAG_KEY = 'iclass-inventory-returns';

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
  /** #41 — SOs whose matched task is dismissed: mirror ingested, task side-effects skipped. */
  skippedDismissed: number;
  /** SOs whose processing threw — logged and skipped so one bad SO never aborts the batch. */
  errored: number;
  /** Tareas cuyo IClass call arrojó error durante el backfill (distinto de errored).
   * Un failed es fallo de tarea completa; errored es fallo de processSummary por SO. */
  failed: number;
}

export interface IngestClosedOptions {
  now?: () => Date;
  overlapMinutes?: number;
  /** Immutable business code of the in-flight stage (sent, awaiting closure). */
  inFlightStageCode?: string;
  /** Cap on audit attempts per SO (reprocess respects the same cap). */
  maxAuditAttempts?: number;
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
  /** #14 — read access to suggestions to compute closureHasDeviceInventory on the task. */
  suggestions?: InventorySuggestionRepository;
  /**
   * EPIC #38 W4 — closure-detected equipment returns (opt-in, non-fatal). When present,
   * a completed RETIRO SO (Sucesso + isRemovalCode) whose `inventoryReturnsProcessed` is
   * false stages one ReturnSuggestion per OCR serial. NEVER mutates stock (staging only).
   */
  stageReturns?: StageReturnSuggestions;
  /**
   * EPIC #38 W4 — when present, the returns side-effect runs ONLY if the
   * `iclass-inventory-returns` flag is enabled (runtime-toggleable, default OFF). When
   * ABSENT, the gate is open (unit tests exercise staging without a flag dependency).
   */
  featureFlags?: FeatureFlagRepository;
  /**
   * #41 REQ-GS-ICLASS-CLOSEDBY-FLOW-1 — optional activity recorder. When wired, a
   * closure flow that moves a task into a `hecho`-category stage also emits a
   * `status_changed` activity (actor System) alongside the generalStatus='closed'
   * write. Best-effort: a recorder that throws never aborts the already-committed move.
   */
  recorder?: TaskActivityRecorder;
  /**
   * iclass-status-sync — optional catalog for auto-discovery of IClass status codes.
   * When present: upserts the statusCode into the catalog and conditionally updates
   * the task's iclassStatusCode for EVERY SO seen (before the terminal-status guard).
   * Absent → legacy behavior (no catalog writes, no status tracking). Opt-in so
   * existing tests that don't inject it remain unaffected.
   */
  statusCatalog?: IClassStatusCatalogRepository;
}

/**
 * Closure loop: pull closed IClass SOs back, mirror the ones that match a local
 * task (by codigo↔sequenceNumber), and move each matched task to the Stage the
 * operator mapped to its result code. Idempotent by iclassUpdatedAt.
 */
export class IngestClosedServiceOrders {
  private readonly now: () => Date;
  private readonly overlapMinutes: number;
  private readonly inFlightStageCode: string;
  private readonly maxAuditAttempts: number;
  private readonly portal?: IClassPortalPort;
  private readonly postComment?: PostClosureComment;
  private readonly extractOcr?: ExtractDeviceInfoFromPhoto;
  private readonly buildSuggestions?: BuildInventorySuggestions;
  private readonly auditInstallation?: AuditInstallationQuality;
  private readonly suggestions?: InventorySuggestionRepository;
  private readonly stageReturns?: StageReturnSuggestions;
  private readonly featureFlags?: FeatureFlagRepository;
  private readonly recorder?: TaskActivityRecorder;
  private readonly statusCatalog?: IClassStatusCatalogRepository;

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
    this.inFlightStageCode = opts.inFlightStageCode ?? DEFAULT_IN_FLIGHT_STAGE_CODE;
    this.maxAuditAttempts = opts.maxAuditAttempts ?? DEFAULT_MAX_AUDIT_ATTEMPTS;
    this.portal = opts.portal;
    this.postComment = opts.postComment;
    this.extractOcr = opts.extractOcr;
    this.buildSuggestions = opts.buildSuggestions;
    this.auditInstallation = opts.auditInstallation;
    this.suggestions = opts.suggestions;
    this.stageReturns = opts.stageReturns;
    this.featureFlags = opts.featureFlags;
    this.recorder = opts.recorder;
    this.statusCatalog = opts.statusCatalog;
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
    // ── iclass-status-sync: status capture BEFORE the terminal guard ─────────
    // The lookup is moved here so we can capture the status for ALL OS states,
    // not just the terminal '7'. The guard below is unchanged.
    // When statusCatalog is absent (legacy callers / existing tests), this block
    // is entirely skipped — no catalog writes, no setIClassStatus call.
    const seq = Number(s.iclassCodigo);
    // FIX 2 — int4-overflow guard: Number.isInteger alone does NOT bound to int4 range.
    // Native IClass SOs have codigo in BigInt territory → PrismaClientValidationError.
    // seq must be a positive integer that fits in PostgreSQL int4 (≤ INT4_MAX).
    const seqInInt4Range = Number.isInteger(seq) && seq > 0 && seq <= INT4_MAX;
    const taskForStatus = this.statusCatalog && seqInInt4Range
      ? await this.scheduling.findTaskBySequenceNumber(seq)
      : null;

    if (this.statusCatalog && taskForStatus) {
      // Auto-discovery: upsert the status code into the catalog (tracked=false default).
      await this.statusCatalog.upsertByStatusCode({
        statusCode: s.statusCode,
        iclassLabel: s.statusDescription,
      });
      // Conditional write: only persists when the code changed (idempotent each tick).
      const statusChanged = taskForStatus.iclassStatusCode !== s.statusCode;
      if (statusChanged) {
        await this.scheduling.setIClassStatus(taskForStatus.id, s.statusCode, new Date());

        // iclass-intermediate-states — auto-move the task to the Stage the operator mapped
        // to this status (prominenseStageId on the catalog row). Fires ONLY when the status
        // actually CHANGED (not on every tick), and is FORWARD-ONLY: moveTaskToStageIfForward
        // never retreats a task to an earlier column, so a manual advance is respected
        // (Stage HAS an `order` column — the repo owns the comparison). The repo also guards
        // against cross-workflow moves (order is per-workflow, so the mapped stage must belong
        // to the task's workflow). Best-effort: a failure here must NEVER break the status
        // capture nor the terminal-closure flow.
        //
        // ACCEPTED behaviour: if the operator manually RETREATS the stage and a DIFFERENT
        // status change then arrives, the forward-only auto-move may re-advance the task. This
        // is intentional — the cron follows IClass as the source of truth. The solo-avanza
        // policy protects against the CRON itself retreating a task; it does NOT protect
        // against overwriting a deliberate manual retreat that precedes a fresh status change.
        try {
          const entry = await this.statusCatalog.getByStatusCode(s.statusCode);
          if (entry?.prominenseStageId) {
            const { moved } = await this.scheduling.moveTaskToStageIfForward(taskForStatus.id, entry.prominenseStageId);
            if (moved) counts.transitioned++;
          }
        } catch (e) {
          console.error(`[iclass-status-sync] auto-move task ${taskForStatus.id} → status ${s.statusCode} failed (non-fatal): ${(e as Error).message}`);
        }
      }
    }
    // ── end iclass-status-sync ───────────────────────────────────────────────

    if (s.statusCode !== TERMINAL_STATUS) {
      counts.skippedNotClosed++;
      return;
    }

    // Join to our work: SO.codigo == ScheduledTask.sequenceNumber. SOs created
    // directly in IClass carry codigo == iclass id (huge / non-our-range) and have
    // no matching task → not ours.
    // NOTE: taskForStatus (above) is the same lookup — reuse it when already fetched.
    // FIX 2 — reuse seqInInt4Range guard (same bound as above) to prevent int4 overflow.
    const task = taskForStatus ?? (seqInInt4Range ? await this.scheduling.findTaskBySequenceNumber(seq) : null);
    if (!task) {
      counts.skippedNotOurs++;
      return;
    }

    // #41 — REQ-GS-ICLASS-INGEST-1: a dismissed task still gets its SO mirrored, but
    // NO task side-effects (stage move, comment, audit, reconcile). The operator
    // discarded it intentionally; mirroring preserves audit without contaminating it.
    const isDismissed = task.generalStatus === 'dismissed';

    // Idempotency — skip re-mirroring if already mirrored at the same modification
    // timestamp. BUT still reconcile a stuck transition: the SO is unchanged, yet
    // the task may remain parked in the in-flight stage because its result-code →
    // stage mapping was missing/failed at first mirror (e.g. a case-mismatch fixed
    // later, or the operator mapped the code afterwards). Re-evaluate ONLY the
    // stage move — never re-mirror or re-fire side-effects (would duplicate
    // comments/audits). No-op when the task already left the in-flight stage.
    const existing = await this.closed.findSyncStateByIclassId(s.iclassId);
    if (existing && existing.iclassUpdatedAt === s.iclassUpdatedAt) {
      // #41 G1 — dismissed: no reconcile, no pending-returns re-attempt. Count and bail.
      if (isDismissed) {
        counts.skippedDismissed++;
        return;
      }
      counts.skippedUnchanged++;
      const rc = await this.resolveResultCode(s);
      if (rc?.mappedStageId) {
        const moved = await this.scheduling.reconcileStuckTaskStage(task.id, rc.mappedStageId, this.inFlightStageCode);
        if (moved) counts.transitioned++;
      }
      // REQ-IDEMP-1 (W4): the unchanged path must still re-attempt a PENDING returns
      // side-effect (inventoryReturnsProcessed=false) — a closure can leave it pending
      // (mid-deploy, OCR was down, a 2nd run after enabling the flag). Reconstruct the
      // order from the mirror (its checklists carry the correlated photoUrls) and stage.
      // Scoped to RETURNS only — comment/inventory/audit re-eval stays out to avoid
      // re-firing already-handled effects on an unchanged SO (keeps existing tests green).
      if (this.stageReturns) {
        const state = await this.closed.getSideEffectState(s.iclassId);
        if (state && !state.inventoryReturnsProcessed) {
          const mirrored = await this.closed.getByIclassId(s.iclassId);
          if (mirrored) await this.processInventoryReturns(mirrored, task.id);
        }
      }
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
    const rc = await this.resolveResultCode(s);

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

    // #41 G2 — dismissed: the mirror is ingested above, but ALL task side-effects are
    // skipped (no stage move, no comment/audit/inventory). Count and bail.
    if (isDismissed) {
      counts.skippedDismissed++;
      console.log(`[iclass-closed] SO ${s.iclassId} (codigo ${s.iclassCodigo}) → task ${task.id} is dismissed: mirror only, side-effects skipped (#41)`);
      return;
    }

    // Move the task only when the operator mapped this result code to a stage.
    if (rc?.mappedStageId) {
      const moved = await this.scheduling.moveTaskToStage(task.id, rc.mappedStageId);
      counts.transitioned++;
      // #41 REQ-GS-ICLASS-CLOSEDBY-FLOW-1 — when the closure flow lands the task in a
      // `hecho`-category stage, the management state follows the workflow outcome:
      // set generalStatus='closed' + emit a System `status_changed`. Tied to THIS move
      // event (not "task is in hecho stage"), so a later reconcile of an UNCHANGED order
      // never re-closes a task the operator reopened (that path never re-invokes this).
      // wave-1a (cierre atómico) — routed through applyTaskClosure(origin='iclass')
      // instead of a bare `task.generalStatus !== 'closed'` + updateTask: that TOCTOU
      // guard was exactly the preexisting staff↔ingest race (design C1/C2). The atomic
      // guard is idempotent by construction (closed:false, no-op when already closed),
      // and — when a DIFFERENT origin got there first with a DIFFERENT resultCode —
      // applyTaskClosure logs the discrepancy instead of silently staying quiet.
      if (moved?.stageCategory === 'hecho') {
        // FIX-4(d) (fix wave W1a) — the discrepancy is reported ONLY on the SO's FIRST
        // transition into closed. IClass bumps `iclassUpdatedAt` on already-ENCERRADO
        // orders (approval, an edited commentary, a billing tweak); each bump escapes
        // the idempotency shortcut above and re-runs this whole block. Without the gate,
        // a task the staff won with a different result would emit a BRAND NEW
        // `closure_conflict` on every single tick — turning a queryable discrepancy into
        // queryable spam. The discriminator needs no extra query: `this.closed.upsert`
        // only runs AFTER the `statusCode !== TERMINAL_STATUS` guard, so the mere
        // EXISTENCE of a mirror row (`existing`) proves this SO was already ingested
        // while closed. `existing === null` ⇔ this run IS the transition.
        // The CLOSE itself is NOT gated: it stays idempotent + atomic, so a task an
        // operator reopened still gets re-closed by a later run, exactly as before.
        const closeResult = await applyTaskClosure(this.scheduling, this.recorder, {
          taskId: task.id,
          origin: 'iclass',
          resultCode: s.resultCodeName ?? null,
          closedByUserId: null,
          reportConflict: existing === null,
        });
        if (closeResult.closed && this.recorder) {
          await this.recorder.record(task.id, 'status_changed', {
            actor: SYSTEM_ACTOR,
            fromValue: task.generalStatus,
            toValue: 'closed',
          });
        }
      }
    }

    await this.runClosureSideEffects(order, task.id, scraped);
  }

  /**
   * Closure side effects (all opt-in, all non-fatal — a failure here never affects
   * the mirror/transition already committed): OCR the SN/MAC device photos, build
   * inventory suggestions (staging), post the readable comment, and run the AI audit.
   *
   * Idempotent per side-effect via the mirror's tracking columns: each effect runs
   * ONLY when not yet marked done, and is marked on success. The audit additionally
   * stops after maxAuditAttempts (a persistently-failing model never hammers Ollama).
   * PUBLIC so the manual reprocess can re-fire only the pending effects on an
   * already-mirrored SO (passing scraped = null — it does not re-scrape the portal).
   */
  async runClosureSideEffects(
    order: ClosedServiceOrder,
    taskId: string,
    scraped: ScrapedOSDetail | null = null,
  ): Promise<void> {
    // #41 F1 — SINGLE CHOKE POINT covering ALL callers (the cron, the manual reprocess
    // via ReprocessClosureSideEffects, the backfill). A dismissed task must never get a
    // comment/inventory/audit posted: the operator discarded it. The G1/G2 ingest guards
    // only cover processSummary; this guard protects the side-effects path itself, so a
    // dismissed task reaching here (e.g. a stale pending row) is bailed before any effect.
    const taskNow = await this.scheduling.getTask(taskId);
    if (taskNow?.generalStatus === 'dismissed') return;

    const state = await this.closed.getSideEffectState(order.iclassId);
    const commentDone = state?.commentPosted ?? false;
    const inventoryDone = state?.inventoryBuilt ?? false;
    const auditDone = state?.auditDone ?? false;
    const auditAttempts = state?.auditAttempts ?? 0;
    const returnsDone = state?.inventoryReturnsProcessed ?? false;

    if (this.buildSuggestions && !inventoryDone) {
      const { extractions, ocrFailed } = await this.collectDeviceExtractions(order, taskId);
      try {
        await this.buildSuggestions.execute({ taskId, extractions, materials: order.materials });
        // Only mark built when no photo failed technically — otherwise stay pending for the reprocess.
        if (!ocrFailed) await this.closed.markSideEffect(order.iclassId, 'inventoryBuilt', true);
        // #14: reflect on the task whether it has ≥1 DEVICE (materials don't count). Never unmark.
        if (this.suggestions && (await this.suggestions.hasDeviceForTask(taskId))) {
          await this.scheduling.markClosureCompleteness(taskId, { closureHasDeviceInventory: true });
        }
      } catch {
        /* non-fatal — stays pending, retried on the next reprocess */
      }
    }

    // EPIC #38 W4 — closure-detected returns. Gated + delegated (so the unchanged-SO
    // path can reuse the same logic). Only when not yet staged (returnsDone false).
    if (this.stageReturns && !returnsDone) {
      await this.processInventoryReturns(order, taskId);
    }

    if (this.postComment && !commentDone) {
      try {
        const attachmentUrls = (scraped?.attachments ?? []).map(a => a.url);
        await this.postComment.execute({ taskId, order, attachmentUrls });
        await this.closed.markSideEffect(order.iclassId, 'commentPosted', true);
        await this.scheduling.markClosureCompleteness(taskId, { closureCommentDone: true }); // #14
      } catch {
        /* non-fatal — stays pending */
      }
    }

    if (this.auditInstallation && !auditDone && auditAttempts < this.maxAuditAttempts) {
      await this.closed.incrementAuditAttempt(order.iclassId);
      try {
        const result = await this.auditInstallation.execute({ taskId, order });
        // execute() returns null on soft-fail (persisted nothing) → leave pending to retry.
        if (result) {
          await this.closed.markSideEffect(order.iclassId, 'auditDone', true);
          await this.scheduling.markClosureCompleteness(taskId, { closureAuditDone: true }); // #14
        }
      } catch (err) {
        // non-fatal — la auditoría IA nunca afecta el cierre ya commiteado, pero LOGUEAMOS el fallo
        // eslint-disable-next-line no-console
        console.error(`[audit] task ${taskId}: side-effect lanzó (no deberia, audit() never throws):`, err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Collect the SN/MAC device extractions from the SO's checklist photos. Shared by
   * inventoryBuilt (W1 #19) and processInventoryReturns (W4). `ocrFailed` is true when a
   * photo OCR failed technically (LLM down) so the caller leaves its flag pending.
   */
  private async collectDeviceExtractions(
    order: ClosedServiceOrder,
    taskId: string,
  ): Promise<{ extractions: OcrExtraction[]; ocrFailed: boolean }> {
    const extractions: OcrExtraction[] = [];
    let ocrFailed = false;
    if (!this.extractOcr) return { extractions, ocrFailed };
    for (const checklist of order.checklists) {
      for (const a of checklist.answers) {
        if (a.questionType === 'Foto' && a.photoUrl && isSnMacDevicePhoto(a.questionText)) {
          try {
            const ext = await this.extractOcr.execute({
              photoUrl: a.photoUrl,
              deviceType: classifyDeviceType(a.questionText),
              serviceOrderId: order.iclassId,
              sourceTaskId: taskId,
            });
            if (ext) extractions.push(ext);
            else ocrFailed = true;
          } catch {
            ocrFailed = true;
          }
        }
      }
    }
    return { extractions, ocrFailed };
  }

  /**
   * EPIC #38 W4 — stage equipment-return suggestions for a completed RETIRO SO. Gate:
   * the resolved result code is a completed removal (`type === 'Sucesso'` AND
   * `isRemovalCode === true`). Stages ONE ReturnSuggestion per OCR serial and sets the
   * L1 idempotency flag. READ-ONLY w.r.t. stock — the operator confirm is the only
   * mutation. Non-fatal: a failure leaves the flag false, retried on the next reprocess.
   * The caller owns the `!inventoryReturnsProcessed` pre-check (so this can re-resolve
   * the gate from both the fresh-mirror and the unchanged-SO paths).
   */
  private async processInventoryReturns(order: ClosedServiceOrder, taskId: string): Promise<void> {
    if (!this.stageReturns) return;
    // Feature-flag gate (W4, default OFF). Only enforced when a flag repo is wired —
    // unit tests omit it so staging is exercised directly. Missing flag → disabled.
    if (this.featureFlags) {
      const flag = await this.featureFlags.get(ICLASS_RETURNS_FLAG_KEY);
      if (!flag?.enabled) return;
    }
    const rc = await this.resolveResultCode(order);
    if (!(rc?.isRemovalCode === true && rc.type === 'Sucesso')) return; // not a completed removal
    try {
      const { extractions } = await this.collectDeviceExtractions(order, taskId);
      await this.stageReturns.execute({ taskId, serviceOrderId: order.iclassId, extractions });
      await this.closed.markInventoryReturnsProcessed(order.iclassId);
    } catch {
      /* non-fatal — stays pending, retried on the next reprocess */
    }
  }

  /**
   * Resolve the closure mapping for an SO. Disambiguates by (soTypeId, code) first
   * — the same result code maps to different stages across SO types (e.g. Posponer
   * → Sin_material for most, Pospuesta for one) — then falls back to a name-only
   * match for SOs with no soTypeId or an uncatalogued type.
   */
  private async resolveResultCode(s: ClosedServiceOrderSummary) {
    if (!s.resultCodeName) return null;

    // Intento exacto primero (sin normalizar): soType → código.
    if (s.soTypeId) {
      const byType = await this.resultCodes.findBySoTypeAndCode(s.soTypeId, s.resultCodeName);
      if (byType) return byType;
    }
    const byCode = await this.resultCodes.findByCode(s.resultCodeName);
    if (byCode) return byCode;

    // Fallback normalizado: rescata variaciones de IClass (puntuación final, espacios internos).
    if (s.soTypeId) {
      const byTypeN = await this.resultCodes.findBySoTypeAndCodeNormalized(s.soTypeId, s.resultCodeName);
      if (byTypeN) return byTypeN;
    }
    return this.resultCodes.findByCodeNormalized(s.resultCodeName);
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
  return { mirrored: 0, transitioned: 0, skippedNotClosed: 0, skippedNotOurs: 0, skippedUnchanged: 0, skippedDismissed: 0, errored: 0, failed: 0 };
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
