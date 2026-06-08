import {
  ClosedServiceOrderRepository,
  PendingClosureSideEffectsWithTask,
} from '@domain/ports/ClosedServiceOrderRepository';

/** Límite de reintentos de auditoría — debe coincidir con el de ReprocessClosureSideEffects. */
const MAX_AUDIT_ATTEMPTS = 3;

export interface PendingSideEffectItem extends PendingClosureSideEffectsWithTask {}

export interface GetPendingSideEffectsListResult {
  items: PendingSideEffectItem[];
  total: number;
}

/**
 * Caso de uso que devuelve el listado de SOs con al menos un side-effect pendiente,
 * enriquecido con la info de la tarea local vinculada.
 *
 * Sirve al endpoint GET /closure/reprocess/pending-list para que el FE muestre
 * la tabla de progreso del reprocess.
 *
 * REQ-LIST-2: total === items.length invariant; never leaks Prisma entities.
 */
export class GetPendingSideEffectsList {
  constructor(private readonly closed: ClosedServiceOrderRepository) {}

  async execute(): Promise<GetPendingSideEffectsListResult> {
    const items = await this.closed.listPendingSideEffectsWithTask(MAX_AUDIT_ATTEMPTS);
    return { items, total: items.length };
  }
}
