import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';
import { ClosedServiceOrderRepository } from '@domain/ports/ClosedServiceOrderRepository';

interface StoredOrder {
  order: ClosedServiceOrder;
  scheduledTaskId: string | null;
}

/** In-memory mirror store for closed-SO use-case tests. */
export class InMemoryClosedServiceOrderRepository implements ClosedServiceOrderRepository {
  /** keyed by iclassId */
  readonly orders = new Map<string, StoredOrder>();

  async findSyncStateByIclassId(iclassId: string): Promise<{ iclassUpdatedAt: string | null } | null> {
    const found = this.orders.get(iclassId);
    return found ? { iclassUpdatedAt: found.order.iclassUpdatedAt } : null;
  }

  async upsert(order: ClosedServiceOrder, scheduledTaskId: string | null): Promise<void> {
    this.orders.set(order.iclassId, { order: structuredCloneSafe(order), scheduledTaskId });
  }
}

/** structuredClone is unavailable in some test runtimes; a JSON round-trip is enough here. */
function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
