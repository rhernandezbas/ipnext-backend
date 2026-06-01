import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { GrLinkResolverPort } from '@domain/ports/GrLinkResolverPort';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { GestionRealIngestConfigRepository } from '@domain/ports/GestionRealIngestConfigRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { ProjectRepository } from '@domain/ports/ProjectRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { TaskPriorityRepository } from '@domain/ports/TaskPriorityRepository';
import { TaskCategoryRepository } from '@domain/ports/TaskCategoryRepository';
import { IngestCatalogEntryMissingError } from '@domain/errors/scheduling';
import { GrServiceOrder } from '@domain/entities/gestionReal';
import { classifyTech } from './classifyTech';

const SYNC_ENTITY = 'gr-ingest';

/**
 * Catalog NAMES every ingested task must be stamped with. `ScheduledTask.priority`
 * and `.category` are strings holding the catalog NAME, so these MUST exist as
 * rows in the TaskPriority / TaskCategory catalogs (prod uses "Normal" — capital N —
 * and "Instalación" — capital + accent). The previous hardcoded 'normal'/'installation'
 * matched NO catalog row, producing phantom values. Resolution is BLOCKING: if either
 * name is absent the run aborts and creates zero tasks (see IngestCatalogEntryMissingError).
 */
const INGEST_PRIORITY_NAME = 'Normal';
const INGEST_CATEGORY_NAME = 'Instalación';

/**
 * Master switch for the whole ingest and the SINGLE runtime on/off gate.
 * Checked PER execution so flipping it via /feature-flags takes effect on the
 * next scheduler tick — no redeploy. OFF → no-op (no GR call, no SyncState).
 */
const INGEST_FLAG_KEY = 'gestion-real-ingest';

const REVISAR_TITLE_PREFIX = '[REVISAR - Logística] Instalación';
const REVISAR_DESCRIPTION = 'Plan no reconocido — asignar tecnología y proyecto manualmente';
/** Needs-review reason when the tech IS classified but its target project is unmapped. */
function projectNotConfiguredDescription(tech: 'FIBER' | 'WIRELESS'): string {
  const label = tech === 'FIBER' ? 'FIBRA' : 'WIRELESS';
  return `Proyecto de ${label} no configurado — mapear en Configuración o asignar manualmente`;
}

/** Detect a unique-constraint violation (Prisma P2002) so a concurrent create is a no-op backstop. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'P2002') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /unique constraint/i.test(message);
}

/** Outcome counts for one ingest run. */
export interface IngestRunResult {
  created: number;
  skippedDuplicate: number;
  skippedUnmirrored: number;
  unclassified: number;
}

export interface IngestOptions {
  /**
   * Fallback initial stage id used when the target project's workflow has no
   * resolvable "Pendiente" stage, and for needs-review (null-project) tasks.
   * Tasks must land in a valid pending stage; `createTask` requires `stageId`.
   */
  defaultStageId: string;
  /** Injectable clock for deterministic window/timestamps. */
  now?: () => Date;
}

/**
 * Ingest pending installation orders from Gestión Real into local ScheduledTasks.
 *
 * Flow (per design): check feature flag → if OFF, no-op → fetch CI-eligible orders
 * (estado=config.sourceEstado [default CONF], fecha_tipo=c, window from windowMonths) → filter tipo==="CI" →
 * resolve client+service FKs locally (miss → skip+count unmirrored) → idempotency
 * check by grOrdenId (exists → skip+count duplicate) → classify tech → pick target
 * project → create task → persist run counts to SyncState ('gr-ingest').
 *
 * Depends ONLY on ports; never on infrastructure. Returns a plain counts DTO.
 */
export class IngestGestionRealOrders {
  private readonly now: () => Date;
  private readonly defaultStageId: string;

  constructor(
    private readonly gr: GestionRealPort,
    private readonly resolver: GrLinkResolverPort,
    private readonly scheduling: SchedulingRepository,
    private readonly config: GestionRealIngestConfigRepository,
    private readonly state: SyncStateRepository,
    private readonly projects: ProjectRepository,
    private readonly featureFlags: FeatureFlagRepository,
    private readonly priorities: TaskPriorityRepository,
    private readonly categories: TaskCategoryRepository,
    opts: IngestOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.defaultStageId = opts.defaultStageId;
  }

  async execute(): Promise<IngestRunResult> {
    const counts: IngestRunResult = {
      created: 0,
      skippedDuplicate: 0,
      skippedUnmirrored: 0,
      unclassified: 0,
    };

    // Master switch (release flag). OFF → no-op. Checked per run so it can be
    // flipped via /feature-flags without a redeploy. Do NOT call GR or touch
    // SyncState (mirrors the disabled-config path).
    const flag = await this.featureFlags.get(INGEST_FLAG_KEY);
    if (!flag?.enabled) return counts;

    // BLOCKING: resolve the catalog entries every task must carry BEFORE touching
    // GR or creating anything. ScheduledTask.priority/.category hold the catalog
    // NAME, so they must match a real row. A miss aborts the whole run with ZERO
    // tasks created — never write a phantom value outside the catalog.
    const priority = await this.priorities.getByName(INGEST_PRIORITY_NAME);
    if (!priority) throw new IngestCatalogEntryMissingError('priority', INGEST_PRIORITY_NAME);
    const category = await this.categories.getByName(INGEST_CATEGORY_NAME);
    if (!category) throw new IngestCatalogEntryMissingError('category', INGEST_CATEGORY_NAME);

    const config = await this.config.get();

    const today = this.now();
    const fechaHasta = formatGrDate(today);
    const fechaDesde = formatGrDate(monthsBack(today, config.windowMonths));

    const orders = await this.gr.getServiceOrders({
      estado: config.sourceEstado,
      fechaTipo: 'c',
      fechaDesde,
      fechaHasta,
    });

    // App-side guard: trust GR's server-side estado filter but re-filter defensively
    // against the SAME configured source estado. The tipo==="CI" (installation)
    // filter is fixed.
    for (const order of orders.filter(o => o.tipo === 'CI' && o.estado === config.sourceEstado)) {
      await this.ingestOne(
        order,
        config.fiberProjectId,
        config.wirelessProjectId,
        priority.name,
        category.name,
        counts,
      );
    }

    await this.state.save({
      entity: SYNC_ENTITY,
      cursor: fechaHasta,
      lastRunAt: this.now(),
      lastResult: JSON.stringify(counts),
      itemsSynced: counts.created,
    });

    return counts;
  }

  private async ingestOne(
    order: GrServiceOrder,
    fiberProjectId: string | null,
    wirelessProjectId: string | null,
    priorityName: string,
    categoryName: string,
    counts: IngestRunResult,
  ): Promise<void> {
    // 1-2. Resolve local FKs. A miss is expected until the mirror catches up; skip + count.
    const client = order.cliente ? await this.resolver.findClientByGrId(order.cliente) : null;
    if (!client) {
      counts.skippedUnmirrored++;
      return;
    }
    const contract = order.contrato
      ? await this.resolver.findContractByGrContratoId(order.contrato)
      : null;
    if (!contract) {
      counts.skippedUnmirrored++;
      return;
    }

    // 3. Idempotency: never create a second task for the same GR order.
    const existing = await this.scheduling.findTaskByGrOrdenId(order.grOrdenId);
    if (existing) {
      counts.skippedDuplicate++;
      return;
    }

    // 4-5. Classify and pick the target project.
    const tech = classifyTech(contract.plan);
    const projectId =
      tech === 'FIBER' ? fiberProjectId : tech === 'WIRELESS' ? wirelessProjectId : null;

    // 6. Needs-review reasons (two distinct cases, both land a REVISAR task):
    //   (a) UNCLASSIFIED      → plan not recognized.
    //   (b) classified but the target project is not configured (projectId null).
    // Both must be a proper needs-review task (REVISAR title + reason), NOT a
    // silent normal task with a null project, and counted in the review bucket.
    const isUnclassified = tech === 'UNCLASSIFIED';
    const isProjectNotConfigured =
      (tech === 'FIBER' || tech === 'WIRELESS') && projectId === null;
    const needsReview = isUnclassified || isProjectNotConfigured;

    const title = needsReview
      ? `${REVISAR_TITLE_PREFIX} ${client.name}`
      : `Instalación ${client.name}`;
    const description = isUnclassified
      ? REVISAR_DESCRIPTION
      : isProjectNotConfigured
        ? projectNotConfiguredDescription(tech as 'FIBER' | 'WIRELESS')
        : null;

    // 7. Resolve initial stage from the project's workflow; fall back to default.
    const stageId = await this.resolveStageId(projectId);

    // 8. Create the task. The check-then-create idempotency is not atomic; a
    // concurrent run under a degraded advisory lock can make createTask throw a
    // unique-constraint violation on grOrdenId. The constraint is the backstop:
    // treat that as a duplicate and continue; never let one order sink the batch.
    try {
      await this.scheduling.createTask({
        title,
        description,
        stageId,
        priority: priorityName,
        estimatedHours: 1,
        address: order.domicilio?.direccion ?? null,
        coordinates: null,
        category: categoryName,
        projectId,
        projectName: null,
        completedAt: null,
        notes: null,
        startDate: null,
        endDate: null,
        customerId: client.id,
        contractId: contract.id,
        partnerId: null,
        reporterId: null,
        assigneeId: null,
        travelTimeTo: null,
        travelTimeFrom: null,
        grOrdenId: order.grOrdenId,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        counts.skippedDuplicate++;
        return;
      }
      // Other errors: log and continue so one bad order can't abort the run and
      // status is still persisted. (No logger port wired here; use console.)
      // eslint-disable-next-line no-console
      console.error(`[gr-ingest] createTask failed for order ${order.grOrdenId}:`, err);
      return;
    }

    if (needsReview) counts.unclassified++;
    else counts.created++;
  }

  /**
   * Resolve the INITIAL stage of the target project's workflow — the stage with
   * the lowest `order`, i.e. the entry state a new task should land in.
   *
   * The real installation workflow has NO stage literally named "Pendiente"
   * (its entry stage is "Nuevo"), so resolving by a magic name returned null and
   * the task fell back to a blank default stage, violating the stageId FK and
   * making every order fail (created=0). Resolving the workflow's first stage by
   * `order` is name-agnostic and works for any workflow.
   *
   * Falls back to `defaultStageId` only when there is no project, no workflow on
   * the project, or the workflow has no stages — and always for needs-review /
   * null-project tasks.
   */
  private async resolveStageId(projectId: string | null): Promise<string> {
    if (projectId) {
      const project = await this.projects.get(projectId);
      const workflowId = project?.workflowId ?? null;
      if (workflowId) {
        const stage = await this.scheduling.getInitialStage(workflowId);
        if (stage) return stage.id;
      }
    }
    return this.defaultStageId;
  }
}

/** Date → "DD-MM-AAAA" (GR's expected window format). */
function formatGrDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

/**
 * Subtract whole months from a date without day-overflow.
 *
 * `setMonth` alone overflows on long→short transitions: from the 31st of March,
 * `setMonth(month-1)` targets Feb 31 which JS rolls forward to March 3, shrinking
 * the window. We clamp the day to the last valid day of the target month so the
 * window is always ≥ the intended months back.
 */
function monthsBack(d: Date, months: number): Date {
  const year = d.getFullYear();
  const targetMonth = d.getMonth() - months;
  // Last day of the target month (day 0 of the next month).
  const lastDayOfTarget = new Date(year, targetMonth + 1, 0).getDate();
  const day = Math.min(d.getDate(), lastDayOfTarget);
  const copy = new Date(d.getTime());
  copy.setFullYear(year, targetMonth, day);
  return copy;
}
