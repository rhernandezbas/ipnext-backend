import { z } from 'zod';
import { IngestConfig } from '@domain/ports/GestionRealIngestConfigRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { SyncState } from '@domain/ports/SyncStateRepository';

// ── Skipped-order refs (REQ-SKIPLIST) ───────────────────────────────────────

/**
 * Why an order was skipped as unmirrored: which local FK failed to resolve.
 * Single source of truth — the type is derived from the list so the parser
 * below can never silently drop a reason added later.
 */
export const UNMIRRORED_REASONS = ['client-unmirrored', 'contract-unmirrored'] as const;
export type UnmirroredReason = (typeof UNMIRRORED_REASONS)[number];

/**
 * GR refs of one skipped order. The mirror can lag GR in two known ways
 * (clients created without ultima_modificacion; new contracts on
 * never-modified clients), so the skip must surface WHO is missing — the
 * operator repairs it by touching the client in GR, not by reading logs + DB.
 */
export interface SkippedOrderRef {
  grOrdenId: string;
  grClienteId: string | null;
  grContratoId: string | null;
  reason: UnmirroredReason;
}

// ── Config DTO ─────────────────────────────────────────────────────────────

/**
 * Outbound config DTO. Shape-identical to the domain `IngestConfig`, but kept
 * as a distinct type so routes/use-cases never leak a Prisma entity and so the
 * wire contract can evolve independently of the storage model.
 */
export interface IngestConfigDTO {
  intervalMs: number;
  windowMonths: number;
  fiberProjectId: string | null;
  wirelessProjectId: string | null;
  /** Configured GR source order state (PEND | CONF | CERR | ANUL). */
  sourceEstado: string;
  /** install-pppoe-pregen (K1): grupo/plan RADIUS para pre-provisionar PPPoE. Null = sin configurar. */
  pppoeProfile: string | null;
}

export function toIngestConfigDTO(config: IngestConfig): IngestConfigDTO {
  return {
    intervalMs: config.intervalMs,
    windowMonths: config.windowMonths,
    fiberProjectId: config.fiberProjectId,
    wirelessProjectId: config.wirelessProjectId,
    sourceEstado: config.sourceEstado,
    pppoeProfile: config.pppoeProfile,
  };
}

/** GR's valid service-order states. The ingest can target any one of these. */
export const GR_SOURCE_ESTADOS = ['PEND', 'CONF', 'CERR', 'ANUL'] as const;

// ── Update Config input validation (REQ-PUTCFG-1) ───────────────────────────

/**
 * Inbound PUT body. Every field optional (partial update). Project FKs are
 * `string | null` (null clears the mapping; existence is validated by the
 * use-case, not here). `intervalMs: "soon"` and friends fail with a Zod error
 * the route maps to 400 VALIDATION_ERROR.
 */
export const UpdateIngestConfigSchema = z
  .object({
    intervalMs: z.number().int().positive(),
    windowMonths: z.number().int().positive(),
    fiberProjectId: z.string().min(1).nullable(),
    wirelessProjectId: z.string().min(1).nullable(),
    sourceEstado: z.enum(GR_SOURCE_ESTADOS),
    /** K1: grupo RADIUS no vacío, o null para limpiar. */
    pppoeProfile: z.string().min(1).nullable(),
  })
  .partial();

export type UpdateIngestConfigInput = z.infer<typeof UpdateIngestConfigSchema>;

// ── Pregen counters (install-pppoe-pregen K1, fix wave observabilidad) ──────

/**
 * Contadores del pregen de PPPoE por run. Sin esto, un orchestrator caído con
 * el flag ON acumula filas `pending` EN SILENCIO — `failed`/`stale` en el
 * status endpoint es la señal operativa. Las keys espejan 1:1 los outcomes de
 * `PregenInstallPppoe` (created | existing | stale | failed).
 */
export interface PregenCounts {
  created: number;
  existing: number;
  stale: number;
  failed: number;
}

export function zeroPregenCounts(): PregenCounts {
  return { created: 0, existing: 0, stale: 0, failed: 0 };
}

// ── Status DTO (REQ-STATUS-1) ───────────────────────────────────────────────

export interface IngestStatusDTO {
  lastRunAt: string | null;
  created: number;
  skippedDuplicate: number;
  skippedUnmirrored: number;
  unclassified: number;
  /** GR refs of the orders skipped as unmirrored on the last run (REQ-SKIPLIST-2). */
  skippedOrders: SkippedOrderRef[];
  /** K1: resultado del pregen de PPPoE del último run (ceros si el flag está OFF o la row es previa a K1). */
  pregen: PregenCounts;
}

/**
 * Maps the `gr-ingest` SyncState into the status DTO. Counts live JSON-encoded in
 * `lastResult` (written by IngestGestionRealOrders). Before any run the state is
 * `null` → `lastRunAt: null` and all counts `0` (REQ-STATUS-1). A `lastResult`
 * that is absent or not valid counts JSON degrades to zeros (never throws).
 */
interface RunCounts {
  created: number;
  skippedDuplicate: number;
  skippedUnmirrored: number;
  unclassified: number;
  skippedOrders: SkippedOrderRef[];
  pregen: PregenCounts;
}

const ZERO_COUNTS: Omit<RunCounts, 'skippedOrders' | 'pregen'> = {
  created: 0,
  skippedDuplicate: 0,
  skippedUnmirrored: 0,
  unclassified: 0,
};

/**
 * Parse the persisted skip list defensively: anything that is not an array of
 * well-formed entries degrades to [] — old SyncState rows predate the field
 * and the status endpoint must never 500 over sync metadata.
 */
function parseSkippedOrders(value: unknown): SkippedOrderRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is SkippedOrderRef => {
    if (typeof e !== 'object' || e === null) return false;
    const entry = e as Record<string, unknown>;
    return (
      typeof entry.grOrdenId === 'string' &&
      (typeof entry.grClienteId === 'string' || entry.grClienteId === null) &&
      (typeof entry.grContratoId === 'string' || entry.grContratoId === null) &&
      typeof entry.reason === 'string' &&
      (UNMIRRORED_REASONS as readonly string[]).includes(entry.reason)
    );
  });
}

export function toIngestStatusDTO(state: SyncState | null): IngestStatusDTO {
  if (!state) {
    return { lastRunAt: null, ...ZERO_COUNTS, skippedOrders: [], pregen: zeroPregenCounts() };
  }
  return {
    lastRunAt: state.lastRunAt ? state.lastRunAt.toISOString() : null,
    ...parseCounts(state.lastResult),
  };
}

function parseCounts(lastResult: string | null): RunCounts {
  if (!lastResult) return { ...ZERO_COUNTS, skippedOrders: [], pregen: zeroPregenCounts() };
  try {
    const parsed = JSON.parse(lastResult) as Record<string, unknown>;
    return {
      created: numberOrZero(parsed['created']),
      skippedDuplicate: numberOrZero(parsed['skippedDuplicate']),
      skippedUnmirrored: numberOrZero(parsed['skippedUnmirrored']),
      unclassified: numberOrZero(parsed['unclassified']),
      skippedOrders: parseSkippedOrders(parsed['skippedOrders']),
      pregen: parsePregen(parsed['pregen']),
    };
  } catch {
    return { ...ZERO_COUNTS, skippedOrders: [], pregen: zeroPregenCounts() };
  }
}

/**
 * K1: parse defensivo de los contadores pregen. Rows previas a K1 (o un blob
 * malformado) degradan a ceros — el status endpoint jamás 500ea por metadata.
 */
function parsePregen(value: unknown): PregenCounts {
  if (typeof value !== 'object' || value === null) return zeroPregenCounts();
  const v = value as Record<string, unknown>;
  return {
    created: numberOrZero(v['created']),
    existing: numberOrZero(v['existing']),
    stale: numberOrZero(v['stale']),
    failed: numberOrZero(v['failed']),
  };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ── Needs-review task DTO (REQ-REVIEW-1) ────────────────────────────────────

/**
 * Outbound DTO for a needs-review ScheduledTask. The domain `ScheduledTask` is
 * already a clean (non-Prisma) entity, but we project it through an explicit DTO
 * so the wire contract is stable and never leaks storage internals.
 */
export interface NeedsReviewTaskDTO {
  id: string;
  title: string;
  description: string | null;
  grOrdenId: string | null;
  projectId: string | null;
  customerId: string | null;
  contractId: string | null;
  address: string | null;
  category: string;
  priority: string;
  stageId: string;
  createdAt: string;
}

export function toNeedsReviewTaskDTO(task: ScheduledTask): NeedsReviewTaskDTO {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    grOrdenId: task.grOrdenId,
    projectId: task.projectId ?? null,
    customerId: task.customerId,
    contractId: task.contractId,
    address: task.address,
    category: task.category,
    priority: task.priority,
    stageId: task.stageId,
    createdAt: task.createdAt,
  };
}
