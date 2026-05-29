import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';

/**
 * Persistence for the mirror of closed IClass Service Orders.
 *
 * Upsert is keyed by `iclassId` and replaces the children (history / checklists /
 * materials / equipment events) wholesale on each run. Idempotency is the caller's
 * job via `findSyncStateByIclassId` (compare iclassUpdatedAt before re-fetching).
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
   * local task when resolved (scheduledTaskId, null when no match).
   */
  upsert(order: ClosedServiceOrder, scheduledTaskId: string | null): Promise<void>;
}
