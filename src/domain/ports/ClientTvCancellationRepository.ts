/**
 * ClientTvCancellationRepository — flag de baja TV LOCAL para un cliente (#72).
 *
 * WHY: el partner Gigared (Gigared) NO tiene un primitive de unlink: PATCH /accounts/{cic}/internal_id
 * con '' siempre devuelve HTTP 400 (verificado live). El mapping internal_id↔CIC es append-only en el
 * partner (PATCH agrega, nunca reemplaza; DELETE → 405/404). Por lo tanto, el estado "cliente no tiene TV"
 * debe vivir LOCALMENTE en el mirror (campo `Client.tvCancelledAt`).
 *
 * La columna `tvCancelledAt` en `Client` es nullable y la sync de GR NUNCA la escribe (es datos propios
 * del mirror, ajenos al sistema de facturación).
 *
 * El flag es IDEMPOTENTE en ambas direcciones:
 *  - markCancelled sobre un cliente ya marcado → no cambia nada (updatedAt puede variar).
 *  - clearCancelled sobre un cliente sin flag → no-op.
 */
export interface ClientTvCancellationRepository {
  /** Marca el cliente como "TV dada de baja localmente" (setea tvCancelledAt = now). Idempotente. */
  markCancelled(clientId: string): Promise<void>;
  /** Limpia el flag (tvCancelledAt = null) — el cliente vuelve a tener TV. Idempotente. */
  clearCancelled(clientId: string): Promise<void>;
  /** True si el cliente tiene tvCancelledAt seteado (TV dada de baja localmente). */
  isCancelled(clientId: string): Promise<boolean>;
}
