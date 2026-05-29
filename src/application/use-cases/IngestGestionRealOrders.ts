import { GestionRealPort } from '@domain/ports/GestionRealPort';
import { GrLinkResolverPort } from '@domain/ports/GrLinkResolverPort';
import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { GestionRealIngestConfigRepository } from '@domain/ports/GestionRealIngestConfigRepository';
import { SyncStateRepository } from '@domain/ports/SyncStateRepository';
import { ProjectRepository } from '@domain/ports/ProjectRepository';
import { GrServiceOrder } from '@domain/entities/gestionReal';
import { classifyTech } from './classifyTech';

const SYNC_ENTITY = 'gr-ingest';

const REVISAR_TITLE_PREFIX = '[REVISAR - Logística] Instalación';
const REVISAR_DESCRIPTION = 'Plan no reconocido — asignar tecnología y proyecto manualmente';
const PENDING_STAGE_NAME = 'Pendiente';
const TASK_CATEGORY = 'installation';

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
 * Flow (per design): read config → if disabled, no-op → fetch CI-eligible orders
 * (estado=PEND, fecha_tipo=c, window from windowMonths) → filter tipo==="CI" →
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

    const config = await this.config.get();
    // Disabled → no-op. Do NOT call GR or touch SyncState (REQ-SCHED-2).
    if (!config.enabled) return counts;

    const today = this.now();
    const fechaHasta = formatGrDate(today);
    const fechaDesde = formatGrDate(monthsBack(today, config.windowMonths));

    const orders = await this.gr.getServiceOrders({
      estado: 'PEND',
      fechaTipo: 'c',
      fechaDesde,
      fechaHasta,
    });

    for (const order of orders.filter(o => o.tipo === 'CI')) {
      await this.ingestOne(order, config.fiberProjectId, config.wirelessProjectId, counts);
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
    counts: IngestRunResult,
  ): Promise<void> {
    // 1-2. Resolve local FKs. A miss is expected until the mirror catches up; skip + count.
    const client = order.cliente ? await this.resolver.findClientByGrId(order.cliente) : null;
    if (!client) {
      counts.skippedUnmirrored++;
      return;
    }
    const service = order.contrato
      ? await this.resolver.findServiceByGrContratoId(order.contrato)
      : null;
    if (!service) {
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
    const tech = classifyTech(service.plan);
    const projectId =
      tech === 'FIBER' ? fiberProjectId : tech === 'WIRELESS' ? wirelessProjectId : null;

    // 6. Title / description: unclassified → REVISAR needs-review task.
    const isUnclassified = tech === 'UNCLASSIFIED';
    const title = isUnclassified
      ? `${REVISAR_TITLE_PREFIX} ${client.name}`
      : `Instalación ${client.name}`;
    const description = isUnclassified ? REVISAR_DESCRIPTION : null;

    // 7. Resolve initial stage from the project's workflow; fall back to default.
    const stageId = await this.resolveStageId(projectId);

    // 8. Create the task.
    await this.scheduling.createTask({
      title,
      description,
      stageId,
      priority: 'normal',
      estimatedHours: 1,
      address: order.domicilio?.direccion ?? null,
      coordinates: null,
      category: TASK_CATEGORY,
      projectId,
      projectName: null,
      completedAt: null,
      notes: null,
      startDate: null,
      endDate: null,
      customerId: client.id,
      serviceId: service.id,
      partnerId: null,
      reporterId: null,
      assigneeId: null,
      travelTimeTo: null,
      travelTimeFrom: null,
      grOrdenId: order.grOrdenId,
    });

    if (isUnclassified) counts.unclassified++;
    else counts.created++;
  }

  /**
   * Resolve the "Pendiente" stage of the target project's workflow. Falls back
   * to the configured default-pending stage when the project has no workflow
   * scope or no matching stage (and always for needs-review / null project).
   */
  private async resolveStageId(projectId: string | null): Promise<string> {
    if (projectId) {
      const project = await this.projects.get(projectId);
      const workflowId = project?.workflowId ?? undefined;
      const stage = await this.scheduling.getStageByName(PENDING_STAGE_NAME, workflowId);
      if (stage) return stage.id;
    }
    const global = await this.scheduling.getStageByName(PENDING_STAGE_NAME);
    return global?.id ?? this.defaultStageId;
  }
}

/** Date → "DD-MM-AAAA" (GR's expected window format). */
function formatGrDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}

/** Subtract whole months from a date (clock-safe copy). */
function monthsBack(d: Date, months: number): Date {
  const copy = new Date(d.getTime());
  copy.setMonth(copy.getMonth() - months);
  return copy;
}
