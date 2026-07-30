/**
 * TvCicReuseEligibilityRepository (gigared-tv-cic-reuse) — ¿se puede reutilizar el CIC del
 * pool que carga la identidad de TV de este cliente?
 *
 * WHY: el partner NO tiene unlink de `internal_id` (el PATCH con '' devuelve 400; el mapeo es
 * append-only, verificado en vivo). Por eso todo CIC que la baja recicla vuelve al pool
 * `unregistered` CARGANDO la identidad del cliente que se dio de baja. El filtro B1 original
 * —nacido del incidente Centeno— rechazaba TODOS, y eso dejó el alta rota al 100%: no distinguía
 * "identidad de un tercero VIVO" (peligroso) de "identidad de un cliente MÍO ya severado
 * localmente" (seguro, y justamente lo que la baja produce a propósito).
 *
 * La invariante son TRES condiciones y las tres son OBLIGATORIAS:
 *   1. el cliente EXISTE en el mirror local
 *   2. tiene `tvCancelledAt` seteado (el severing local del #72)
 *   3. NO tiene ninguna fila de `ContractService` de TV ACTIVA
 *
 * La 3 es defensiva: `CancelTv` mueve el flag y la fila juntos, pero el caso ALVEZ SUSANA
 * (2026-07-30) probó que el drift EXISTE. Reutilizar el CIC de un cliente con una fila de TV
 * viva dejaría a esa fila apuntando a una cuenta que pasó a ser de otro.
 *
 * WHY UN PUERTO PROPIO y no componer `ClientTvCancellationRepository.isCancelled` con una
 * consulta de ContractService: son tres predicados que deben evaluarse JUNTOS. Resolverlos por
 * separado en la capa de aplicación abre una ventana TOCTOU entre "está dado de baja" y "no
 * tiene fila activa", y filtra lógica de consulta al use case. El puerto expresa la PREGUNTA
 * DE NEGOCIO, no sus partes.
 */
export interface TvCicReuseEligibilityRepository {
  /**
   * True SÓLO si las tres condiciones se cumplen. Un cliente inexistente devuelve false
   * (nunca lanza): "no lo conozco" es indistinguible de "no es elegible" para el caller, y el
   * lado seguro es no reutilizar.
   */
  isEligibleForCicReuse(clientId: string): Promise<boolean>;
}
