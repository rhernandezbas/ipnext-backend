/**
 * ai-assistant-multiagent (RTR-0) — ruteo de las conversaciones SIN área.
 *
 * Existe por un hallazgo del 2026-07-26: `Conversation.areaId` lo escribe únicamente
 * `SetConversationArea`, una acción manual en la UI de Prominense — y los agentes trabajan
 * dentro de Chatwoot. O sea, las conversaciones de WhatsApp entran con `areaId = NULL` y
 * nadie las clasifica. Un motor que exigiera área **nunca se habría activado**: feature
 * inerte en producción, con toda la suite en verde.
 *
 * Molde config-singleton del repo (`NocAlertThresholdsConfigRepository`).
 */
export interface AssistantRoutingConfig {
  /**
   * Área que atiende lo que entra sin clasificar. `null` = NADIE: las conversaciones sin
   * área no se atienden. Es el default a propósito — un agente recién instalado no debe
   * empezar a contestarle a todo el mundo por el solo hecho de existir.
   */
  defaultAreaId: string | null;
  /**
   * Habilita el re-ruteo: si el agente default detecta que el tema pertenece a otra área con
   * agente propio, reasigna la conversación y esa área la toma. OFF ⇒ el default atiende todo
   * y nunca reasigna (una llamada menos al modelo, una superficie menos que puede fallar).
   */
  rerouteEnabled: boolean;
}

/** Default seguro cuando todavía no hay fila persistida: nadie atiende, no se re-rutea. */
export const ASSISTANT_ROUTING_DEFAULTS: AssistantRoutingConfig = {
  defaultAreaId: null,
  rerouteEnabled: false,
};

export interface AssistantRoutingConfigRepository {
  /** Config vigente; devuelve los defaults seguros si nunca se persistió nada. */
  get(): Promise<AssistantRoutingConfig>;
  /** Reemplaza la config completa (no hay merge parcial: son dos campos). */
  update(config: AssistantRoutingConfig): Promise<AssistantRoutingConfig>;
}
