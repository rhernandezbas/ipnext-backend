import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { GrLinkResolverPort } from '@domain/ports/GrLinkResolverPort';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { GestionRealIngestConfigRepository } from '@domain/ports/GestionRealIngestConfigRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { ProjectRepository } from '@domain/ports/ProjectRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { TaskPriorityRepository } from '@domain/ports/TaskPriorityRepository';
import { TaskCategoryRepository } from '@domain/ports/TaskCategoryRepository';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { IngestCatalogEntryMissingError } from '@domain/errors/scheduling';
import { GrServiceOrder } from '@domain/entities/gestionReal';
import {
  SkippedOrderRef,
  UnmirroredReason,
  PregenCounts,
  zeroPregenCounts,
} from '@application/dto/gestionRealIngest.dto';
import { classifyTech } from './classifyTech';
import { PregenInstallPppoe, renderPppoeCredentialsBlock } from './PregenInstallPppoe';

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

/**
 * install-pppoe-pregen (K1): flag de la PRE-GENERACIÓN de credenciales PPPoE en
 * instalaciones. INDEPENDIENTE del master switch: gatea SOLO el side-effect
 * PPPoE + el bloque de credenciales en la descripción, nunca el ingest en sí.
 * Default OFF (seed por migración); chequeado POR RUN — se prende via
 * /feature-flags sin redeploy. Requiere además `config.pppoeProfile` seteado.
 */
const PREGEN_FLAG_KEY = 'install-pppoe-pregen';

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

/**
 * Cap on the persisted/exposed skip refs (REQ-SKIPLIST-3). A stalled mirror
 * (clients sync down or flag off) makes EVERY CI order in the window skip, and
 * the list is rebuilt per run — without a cap each tick would persist and serve
 * an unbounded blob. `skippedUnmirrored` always carries the real total.
 */
const MAX_SKIPPED_REFS = 100;

/** Outcome counts for one ingest run. */
export interface IngestRunResult {
  created: number;
  skippedDuplicate: number;
  skippedUnmirrored: number;
  unclassified: number;
  /** First MAX_SKIPPED_REFS unmirrored skips (REQ-SKIPLIST-1); total in `skippedUnmirrored`. */
  skippedOrders: SkippedOrderRef[];
  /**
   * K1 (fix wave observabilidad): resultado del pregen de PPPoE por outcome.
   * Ceros cuando el flag está OFF / el colaborador no está wired. Sin esto, un
   * orchestrator caído con el flag ON acumula filas `pending` en silencio.
   */
  pregen: PregenCounts;
}

export interface IngestOptions {
  /**
   * Fallback initial stage id used when the target project's workflow has no
   * resolvable "Pendiente" stage, and for needs-review (null-project) tasks.
   * Tasks must land in a valid pending stage; `createTask` requires `stageId`.
   */
  defaultStageId: string;
  /**
   * Login of the system user to stamp as the task `reporterId` (#15). The ingest
   * resolves its id PER RUN via RbacUserRepository, so a user seeded after the
   * scheduler started is picked up on the next tick without a redeploy. When
   * omitted (or the user is absent) tasks fall back to a null reporter.
   */
  apiReporterLogin?: string;
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
  private readonly apiReporterLogin: string | null;

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
    private readonly rbacUsers: RbacUserRepository,
    opts: IngestOptions,
    /**
     * install-pppoe-pregen (K1): colaborador OPCIONAL (trailing, patrón
     * CreatePppoeService) que pre-provisiona el PPPoE del contrato de cada
     * instalación ingestada. Ausente (fixtures legacy / GR sin RADIUS wiring)
     * → la pre-generación queda apagada aunque el flag esté ON.
     */
    private readonly pregenPppoe?: PregenInstallPppoe,
  ) {
    this.now = opts.now ?? (() => new Date());
    this.defaultStageId = opts.defaultStageId;
    this.apiReporterLogin = opts.apiReporterLogin ?? null;
  }

  async execute(): Promise<IngestRunResult> {
    const counts: IngestRunResult = {
      created: 0,
      skippedDuplicate: 0,
      skippedUnmirrored: 0,
      unclassified: 0,
      skippedOrders: [],
      pregen: zeroPregenCounts(),
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

    // Resolve the system "Api" reporter ONCE per run (#15). Resolving here — not
    // in the constructor — means a user seeded after the scheduler started is
    // picked up on the next tick. Absent user → null reporter (degraded, never fatal).
    const reporterId = this.apiReporterLogin
      ? (await this.rbacUsers.findByLogin(this.apiReporterLogin))?.id ?? null
      : null;

    const config = await this.config.get();

    // K1: profile RADIUS efectivo para la pre-generación de PPPoE en este run.
    // Null = pre-generación apagada (flag OFF, colaborador ausente o profile sin
    // configurar) → comportamiento actual INTACTO.
    const pregenProfile = await this.resolvePregenProfile(config.pppoeProfile);

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
        reporterId,
        pregenProfile,
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
    reporterId: string | null,
    pregenProfile: string | null,
    counts: IngestRunResult,
  ): Promise<void> {
    // 1-2. Resolve local FKs. A miss is expected until the mirror catches up;
    // skip + count + record the GR refs so the status endpoint can list them.
    const client = order.cliente ? await this.resolver.findClientByGrId(order.cliente) : null;
    if (!client) {
      recordSkip(counts, order, 'client-unmirrored');
      return;
    }
    const contract = order.contrato
      ? await this.resolver.findContractByGrContratoId(order.contrato)
      : null;
    if (!contract) {
      recordSkip(counts, order, 'contract-unmirrored');
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
    let projectId =
      tech === 'FIBER' ? fiberProjectId : tech === 'WIRELESS' ? wirelessProjectId : null;

    // #40 DEBT — the project↔kind guard. CreateTask refuses to put a customer-kind
    // task on a project flagged isNetworkProject; this ingest calls the repo
    // directly and would bypass that guard. Mirror it here: if the configured
    // target project is (mis)flagged as a network project, DON'T create a customer
    // task on it — degrade to needs-review (null project), exactly like the
    // "project not configured" case below. Graceful: the batch is not aborted.
    if (projectId !== null) {
      const targetProject = await this.projects.get(projectId);
      if (targetProject?.isNetworkProject === true) projectId = null;
    }

    // 6. Needs-review reasons (two distinct cases, both land a REVISAR task):
    //   (a) UNCLASSIFIED      → plan not recognized.
    //   (b) classified but the target project is not configured (projectId null) —
    //       this now ALSO covers a target project misflagged as network (#40 debt).
    // Both must be a proper needs-review task (REVISAR title + reason), NOT a
    // silent normal task with a null project, and counted in the review bucket.
    const isUnclassified = tech === 'UNCLASSIFIED';
    const isProjectNotConfigured =
      (tech === 'FIBER' || tech === 'WIRELESS') && projectId === null;
    const needsReview = isUnclassified || isProjectNotConfigured;

    const title = needsReview
      ? `${REVISAR_TITLE_PREFIX} ${client.name}`
      : `Instalación ${client.name}`;
    // Needs-review tasks keep their REVISAR reason; normal tasks carry the GR
    // order comment (#16). Order matters: the needs-review reason must NOT be
    // clobbered by observaciones.
    const baseDescription = isUnclassified
      ? REVISAR_DESCRIPTION
      : isProjectNotConfigured
        ? projectNotConfiguredDescription(tech as 'FIBER' | 'WIRELESS')
        : order.observaciones;

    // K1 (install-pppoe-pregen): pre-provisionar el PPPoE del contrato ANTES de
    // crear la tarea — el bloque de credenciales viaja en la descripción, así que
    // tiene que existir al armarla. Aplica a TODAS las instalaciones CI con
    // contrato resuelto (fibra Y wireless — la ONT también dial-in PPPoE — e
    // incluso needs-review: la instalación va a suceder igual tras el arreglo
    // manual). `order.contrato` es non-null acá (el contrato local se resolvió a
    // partir de él), el guard es solo para TypeScript. Un outcome `failed` no
    // produce bloque y NUNCA aborta la orden (la tarea se crea igual).
    let pppoeBlock: string | null = null;
    if (pregenProfile && this.pregenPppoe && order.contrato) {
      const outcome = await this.pregenPppoe.execute({
        contractId: contract.id,
        grContratoId: order.contrato,
        grClienteId: order.cliente,
        clientName: client.name,
        profile: pregenProfile,
      });
      // Los outcomes espejan 1:1 las keys de PregenCounts (observabilidad K1).
      counts.pregen[outcome.status]++;
      pppoeBlock = renderPppoeCredentialsBlock(outcome);
    }
    // Sin bloque → descripción EXACTAMENTE como siempre (incluido null).
    const description = pppoeBlock
      ? baseDescription
        ? `${baseDescription}\n\n${pppoeBlock}`
        : pppoeBlock
      : baseDescription;

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
        reporterId,
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
   * K1: profile RADIUS efectivo para la pre-generación de PPPoE, o null si la
   * feature está apagada para este run. Tres gates, TODOS necesarios:
   *  1. colaborador wired (composition root / harness de test),
   *  2. flag `install-pppoe-pregen` ON (chequeado por run, como el master),
   *  3. `config.pppoeProfile` configurado — un usuario del RADIUS central
   *     NECESITA su grupo (radusergroup); sin profile la pre-provisión es
   *     imposible y se degrada a no-op CON warning (visible en el log del tick).
   */
  private async resolvePregenProfile(configured: string | null): Promise<string | null> {
    if (!this.pregenPppoe) return null;
    const flag = await this.featureFlags.get(PREGEN_FLAG_KEY);
    if (!flag?.enabled) return null;
    if (!configured) {
      // eslint-disable-next-line no-console
      console.warn(
        '[gr-ingest] install-pppoe-pregen ON pero pppoeProfile sin configurar — pre-generación deshabilitada este run',
      );
      return null;
    }
    return configured;
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

/** Count an unmirrored skip and record its GR refs (capped at MAX_SKIPPED_REFS). */
function recordSkip(counts: IngestRunResult, order: GrServiceOrder, reason: UnmirroredReason): void {
  counts.skippedUnmirrored++;
  if (counts.skippedOrders.length < MAX_SKIPPED_REFS) {
    counts.skippedOrders.push({
      grOrdenId: order.grOrdenId,
      grClienteId: order.cliente ?? null,
      grContratoId: order.contrato ?? null,
      reason,
    });
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
