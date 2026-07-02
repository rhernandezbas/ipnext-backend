/**
 * pppoe-bulk.ts — domain errors for BulkChangePppoePlan (pppoe-search-bulk-plan).
 *
 * These are REQUEST-level errors that abort the whole bulk before any mutation:
 *   BulkEmptyIdsError        → HTTP 422 (ids vacío tras dedup — en la práctica inalcanzable vía
 *                              HTTP: el Zod `ids.min(1)` de la ruta ya devuelve 422 antes de que
 *                              el use case corra. Queda como defensa para callers directos.)
 *   BulkTooLargeError        → HTTP 422 (ids > 200)
 *   PlanNotFoundForBulkError → HTTP 422 (plan code not in catalog — fail-fast)
 *
 * Per-item failures during execution are NOT domain errors — they are captured in the
 * `failed[]` result array (best-effort). Only pre-flight validation throws.
 */
import { DomainError } from './index';

/**
 * S2 fix-wave: el `ids` array quedó vacío tras el dedup. En producción esto es inalcanzable vía
 * HTTP (el Zod `ids: z.array(...).min(1)` de la ruta ya rechaza con 422 antes de llegar al use
 * case) — se mantiene como error DEDICADO para callers directos (tests, futuros callers internos)
 * para que el mensaje no diga engañosamente "recibió 0 ids, máximo 200" (texto de BulkTooLargeError).
 */
export class BulkEmptyIdsError extends DomainError {
  constructor() {
    super('El lote está vacío: no se recibió ningún id para procesar.', 'BULK_EMPTY_IDS');
    this.name = 'BulkEmptyIdsError';
  }
}

/**
 * The `ids` array exceeds the maximum allowed per request (200).
 * Code → HTTP 422. Cero mutación.
 */
export class BulkTooLargeError extends DomainError {
  constructor(public readonly count: number, public readonly max: number = 200) {
    super(
      `Bulk change-plan recibió ${count} ids, pero el máximo permitido es ${max}. Reducí la selección.`,
      'BULK_TOO_LARGE',
    );
    this.name = 'BulkTooLargeError';
  }
}

/**
 * The requested plan/profile code does not exist in the Plan catalog.
 * Fail-fast BEFORE starting any mutation. Code → HTTP 422.
 */
export class PlanNotFoundForBulkError extends DomainError {
  constructor(public readonly profile: string) {
    super(
      `El plan '${profile}' no existe en el catálogo. Verificá el código antes de ejecutar el bulk.`,
      'PLAN_NOT_FOUND',
    );
    this.name = 'PlanNotFoundForBulkError';
  }
}
