import { z } from 'zod';
import { IngestConfig } from '@domain/ports/GestionRealIngestConfigRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { SyncState } from '@domain/ports/SyncStateRepository';

// ── Config DTO ─────────────────────────────────────────────────────────────

/**
 * Outbound config DTO. Shape-identical to the domain `IngestConfig`, but kept
 * as a distinct type so routes/use-cases never leak a Prisma entity and so the
 * wire contract can evolve independently of the storage model.
 */
export interface IngestConfigDTO {
  enabled: boolean;
  intervalMs: number;
  windowMonths: number;
  fiberProjectId: string | null;
  wirelessProjectId: string | null;
}

export function toIngestConfigDTO(config: IngestConfig): IngestConfigDTO {
  return {
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    windowMonths: config.windowMonths,
    fiberProjectId: config.fiberProjectId,
    wirelessProjectId: config.wirelessProjectId,
  };
}

// ── Update Config input validation (REQ-PUTCFG-1) ───────────────────────────

/**
 * Inbound PUT body. Every field optional (partial update). Project FKs are
 * `string | null` (null clears the mapping; existence is validated by the
 * use-case, not here). `intervalMs: "soon"` and friends fail with a Zod error
 * the route maps to 400 VALIDATION_ERROR.
 */
export const UpdateIngestConfigSchema = z
  .object({
    enabled: z.boolean(),
    intervalMs: z.number().int().positive(),
    windowMonths: z.number().int().positive(),
    fiberProjectId: z.string().min(1).nullable(),
    wirelessProjectId: z.string().min(1).nullable(),
  })
  .partial();

export type UpdateIngestConfigInput = z.infer<typeof UpdateIngestConfigSchema>;

// ── Status DTO (REQ-STATUS-1) ───────────────────────────────────────────────

export interface IngestStatusDTO {
  lastRunAt: string | null;
  created: number;
  skippedDuplicate: number;
  skippedUnmirrored: number;
  unclassified: number;
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
}

const ZERO_COUNTS: RunCounts = {
  created: 0,
  skippedDuplicate: 0,
  skippedUnmirrored: 0,
  unclassified: 0,
};

export function toIngestStatusDTO(state: SyncState | null): IngestStatusDTO {
  if (!state) {
    return { lastRunAt: null, ...ZERO_COUNTS };
  }
  return {
    lastRunAt: state.lastRunAt ? state.lastRunAt.toISOString() : null,
    ...parseCounts(state.lastResult),
  };
}

function parseCounts(lastResult: string | null): RunCounts {
  if (!lastResult) return { ...ZERO_COUNTS };
  try {
    const parsed = JSON.parse(lastResult) as Record<string, unknown>;
    return {
      created: numberOrZero(parsed['created']),
      skippedDuplicate: numberOrZero(parsed['skippedDuplicate']),
      skippedUnmirrored: numberOrZero(parsed['skippedUnmirrored']),
      unclassified: numberOrZero(parsed['unclassified']),
    };
  } catch {
    return { ...ZERO_COUNTS };
  }
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
  serviceId: string | null;
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
    serviceId: task.serviceId,
    address: task.address,
    category: task.category,
    priority: task.priority,
    stageId: task.stageId,
    createdAt: task.createdAt,
  };
}
