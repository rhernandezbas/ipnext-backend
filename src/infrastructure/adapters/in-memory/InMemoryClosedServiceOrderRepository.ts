import { ClosedServiceOrder } from '@domain/entities/iclass-closed-order';
import {
  ClosedServiceOrderRepository,
  ClosureSideEffect,
  ClosureSideEffectState,
  PendingClosureSideEffects,
  PendingClosureSideEffectsWithTask,
} from '@domain/ports/ClosedServiceOrderRepository';

interface StoredOrder {
  order: ClosedServiceOrder;
  scheduledTaskId: string | null;
  sideEffects: ClosureSideEffectState;
  /** FIX-B — ISO del PRIMER intento de cierre, o null. Columna en Postgres. */
  closureAttemptedAt: string | null;
}

type TaskInfo = { id: string; sequenceNumber: number; title: string; generalStatus?: 'open' | 'closed' | 'dismissed' };

function freshState(): ClosureSideEffectState {
  return {
    commentPosted: false,
    inventoryBuilt: false,
    auditDone: false,
    auditAttempts: 0,
    inventoryReturnsProcessed: false,
  };
}

/** In-memory mirror store for closed-SO use-case tests. */
export class InMemoryClosedServiceOrderRepository implements ClosedServiceOrderRepository {
  /** keyed by iclassId */
  readonly orders = new Map<string, StoredOrder>();

  /**
   * Injectable tasks Map for `listPendingSideEffectsWithTask`.
   * Seeded by tests; defaults to empty (all task joins resolve null).
   */
  constructor(private readonly tasks: Map<string, TaskInfo> = new Map()) {}

  async findSyncStateByIclassId(
    iclassId: string,
  ): Promise<{ iclassUpdatedAt: string | null; closureAttemptedAt: string | null } | null> {
    const found = this.orders.get(iclassId);
    return found
      ? { iclassUpdatedAt: found.order.iclassUpdatedAt, closureAttemptedAt: found.closureAttemptedAt }
      : null;
  }

  async upsert(order: ClosedServiceOrder, scheduledTaskId: string | null): Promise<void> {
    // Preserve existing side-effect state across a re-mirror (upsert never resets it).
    const prev = this.orders.get(order.iclassId);
    this.orders.set(order.iclassId, {
      order: structuredCloneSafe(order),
      scheduledTaskId,
      sideEffects: prev?.sideEffects ?? freshState(),
      // FIX-B — el re-mirror TAMPOCO resetea el sello del intento (paridad con el
      // Prisma, donde `upsert` no toca esa columna). Si lo reseteara, cada bump de
      // iclassUpdatedAt volvería a habilitar el reporte: el bug de vuelta.
      closureAttemptedAt: prev?.closureAttemptedAt ?? null,
    });
  }

  async getByIclassId(iclassId: string): Promise<ClosedServiceOrder | null> {
    const found = this.orders.get(iclassId);
    return found ? structuredCloneSafe(found.order) : null;
  }

  async getSideEffectState(iclassId: string): Promise<ClosureSideEffectState | null> {
    const found = this.orders.get(iclassId);
    return found ? { ...found.sideEffects } : null;
  }

  async listPendingSideEffects(maxAuditAttempts: number): Promise<PendingClosureSideEffects[]> {
    const out: PendingClosureSideEffects[] = [];
    for (const [iclassId, s] of this.orders) {
      // #41 F1 — exclude SOs whose linked task is dismissed (parity with Prisma WHERE).
      if (this.isDismissed(s.scheduledTaskId)) continue;
      const se = s.sideEffects;
      const pending =
        !se.commentPosted || !se.inventoryBuilt || (!se.auditDone && se.auditAttempts < maxAuditAttempts);
      if (pending) out.push({ iclassId, scheduledTaskId: s.scheduledTaskId, ...se });
    }
    return out;
  }

  async listPendingSideEffectsWithTask(maxAuditAttempts: number): Promise<PendingClosureSideEffectsWithTask[]> {
    const out: PendingClosureSideEffectsWithTask[] = [];
    for (const [iclassId, s] of this.orders) {
      // #41 F1 — dismissed tasks are excluded (the FE progress table must not show them).
      if (this.isDismissed(s.scheduledTaskId)) continue;
      const se = s.sideEffects;
      const pending =
        !se.commentPosted || !se.inventoryBuilt || (!se.auditDone && se.auditAttempts < maxAuditAttempts);
      if (pending) {
        const info = s.scheduledTaskId ? (this.tasks.get(s.scheduledTaskId) ?? null) : null;
        // Keep the task projection shape stable (no generalStatus leaked).
        const task = info ? { id: info.id, sequenceNumber: info.sequenceNumber, title: info.title } : null;
        out.push({ iclassId, scheduledTaskId: s.scheduledTaskId, ...se, task });
      }
    }
    return out;
  }

  /** True only when the SO's task IS in the seeded map AND is dismissed. Null/unknown tasks are kept. */
  private isDismissed(scheduledTaskId: string | null): boolean {
    if (!scheduledTaskId) return false;
    return this.tasks.get(scheduledTaskId)?.generalStatus === 'dismissed';
  }

  async markSideEffect(iclassId: string, effect: ClosureSideEffect, done: boolean): Promise<void> {
    const found = this.orders.get(iclassId);
    if (found) found.sideEffects[effect] = done;
  }

  /** FIX-B — sella el PRIMER intento; una segunda llamada NO mueve el timestamp. */
  async markClosureAttempted(iclassId: string): Promise<void> {
    const found = this.orders.get(iclassId);
    if (found && found.closureAttemptedAt === null) {
      found.closureAttemptedAt = new Date().toISOString();
    }
  }

  async markInventoryReturnsProcessed(iclassId: string): Promise<void> {
    const found = this.orders.get(iclassId);
    if (found) found.sideEffects.inventoryReturnsProcessed = true;
  }

  async incrementAuditAttempt(iclassId: string): Promise<void> {
    const found = this.orders.get(iclassId);
    if (found) found.sideEffects.auditAttempts += 1;
  }
}

/** structuredClone is unavailable in some test runtimes; a JSON round-trip is enough here. */
function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
