import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';

/** Closure side-effects tracked per mirrored SO (drives the manual reprocess). */
export type ClosureSideEffect = 'commentPosted' | 'inventoryBuilt' | 'auditDone';

/** Per-side-effect completion state of a mirrored closure. */
export interface ClosureSideEffectState {
  commentPosted: boolean;
  inventoryBuilt: boolean;
  auditDone: boolean;
  auditAttempts: number;
}

/** A mirror with at least one pending side-effect, plus its local task link. */
export interface PendingClosureSideEffects extends ClosureSideEffectState {
  iclassId: string;
  scheduledTaskId: string | null;
}

/** Same as PendingClosureSideEffects but includes the joined local task info (or null). */
export interface PendingClosureSideEffectsWithTask extends PendingClosureSideEffects {
  task: { id: string; sequenceNumber: number; title: string } | null;
}

/**
 * Persistence for the mirror of closed IClass Service Orders.
 *
 * Upsert is keyed by `iclassId` and replaces the children (history / checklists /
 * materials / equipment events) wholesale on each run. Idempotency is the caller's
 * job via `findSyncStateByIclassId` (compare iclassUpdatedAt before re-fetching).
 *
 * Side-effect tracking columns (commentPosted/inventoryBuilt/auditDone/auditAttempts)
 * are PRESERVED by upsert and only moved by the closure orchestration + the manual
 * reprocess, so re-mirroring an SO never resets which effects already ran.
 */
export interface ClosedServiceOrderRepository {
  /**
   * Returns the idempotency watermark for an already-mirrored SO, or null when
   * it has never been ingested. The caller skips the expensive sub-resource
   * fetch + upsert when the stored iclassUpdatedAt matches the incoming one.
   */
  findSyncStateByIclassId(iclassId: string): Promise<{ iclassUpdatedAt: string | null } | null>;
  /**
   * Upsert the full aggregate (SO + children) keyed by iclassId, linking it to a
   * local task when resolved (scheduledTaskId, null when no match). Does NOT touch
   * the side-effect tracking columns.
   */
  upsert(order: ClosedServiceOrder, scheduledTaskId: string | null): Promise<void>;
  /** Reconstruct the full aggregate (SO + children) from the mirror, or null. */
  getByIclassId(iclassId: string): Promise<ClosedServiceOrder | null>;
  /** Current per-side-effect completion state, or null when the SO is not mirrored. */
  getSideEffectState(iclassId: string): Promise<ClosureSideEffectState | null>;
  /**
   * Mirrors with at least one side-effect still pending: commentPosted=false OR
   * inventoryBuilt=false OR (auditDone=false AND auditAttempts < maxAuditAttempts).
   */
  listPendingSideEffects(maxAuditAttempts: number): Promise<PendingClosureSideEffects[]>;
  /**
   * Same filter as listPendingSideEffects but joins the linked ScheduledTask
   * (single query, no N+1). Returns task info or null when scheduledTaskId is null
   * or the task cannot be resolved.
   */
  listPendingSideEffectsWithTask(maxAuditAttempts: number): Promise<PendingClosureSideEffectsWithTask[]>;
  /** Set a single side-effect completion column. */
  markSideEffect(iclassId: string, effect: ClosureSideEffect, done: boolean): Promise<void>;
  /** Increment auditAttempts and stamp lastAuditAttemptAt = now (cap guard upstream). */
  incrementAuditAttempt(iclassId: string): Promise<void>;
}
