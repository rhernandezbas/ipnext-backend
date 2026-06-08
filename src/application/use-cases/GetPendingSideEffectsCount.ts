import { ClosedServiceOrderRepository } from '@domain/ports/ClosedServiceOrderRepository';

/** Límite de reintentos de auditoría — debe coincidir con el de ReprocessClosureSideEffects. */
const MAX_AUDIT_ATTEMPTS = 3;

export interface GetPendingSideEffectsCountResult {
  pending: number;
}

/**
 * Caso de uso delgado que devuelve la cantidad de SOs con al menos un
 * side-effect pendiente (comment, inventory o audit). Sirve al endpoint
 * GET /closure/reprocess/pending-count para que el FE muestre el progreso.
 */
export class GetPendingSideEffectsCount {
  constructor(private readonly closed: ClosedServiceOrderRepository) {}

  async execute(): Promise<GetPendingSideEffectsCountResult> {
    const pending = await this.closed.listPendingSideEffects(MAX_AUDIT_ATTEMPTS);
    return { pending: pending.length };
  }
}
