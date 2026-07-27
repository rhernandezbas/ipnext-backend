/**
 * ai-assistant-multiagent (SEC-1 / SEC-5) — resolución del cliente por teléfono.
 *
 * Puerto ANGOSTO: el motor no necesita el `Customer` completo — necesita saber a quién
 * consultar, si pidió la baja del canal, y qué strings NUNCA pueden aparecer en los hechos.
 */
export interface AssistantClientIdentity {
  /**
   * Identificador OPACO para que los resolvers consulten. NUNCA viaja al modelo.
   * `null` = el teléfono no matcheó ningún cliente (conversación anónima).
   */
  clientId: string | null;

  /** SEC-5 — pidió la baja del canal (BAJA/STOP). Precedencia absoluta sobre la config. */
  optedOut: boolean;

  /**
   * SEC-1 — valores de identidad REALES (nombre, email, teléfono, documento) que se usan
   * como `forbiddenValues` de `assertFactsArePiiFree`.
   *
   * ⚠️ Estos strings existen SÓLO para comparar del lado de acá. Que estén en memoria es
   * exactamente lo que permite garantizar que NO salgan: sin ellos, la barrera no podría
   * detectar un valor de identidad con clave inocente (`titular: "Juan Pérez"`).
   */
  identityValues: string[];
}

export interface AssistantClientResolver {
  /** Nunca lanza por ausencia: un teléfono desconocido devuelve `clientId: null`. */
  resolveByPhone(phone: string | null): Promise<AssistantClientIdentity>;
}
