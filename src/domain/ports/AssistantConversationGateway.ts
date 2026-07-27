/**
 * ai-assistant-multiagent (RUN-3, design D4/D11) — salida del motor hacia la conversación.
 *
 * ⚠️ **El agente NO tiene camino propio de salida.** Cada método de este puerto se implementa
 * delegando en los use cases que YA usan los humanos (`SendMessage`, `SetConversationArea`,
 * `SetConversationStatus`, `SetConversationLabels`). Así el bot hereda gratis la auditoría, el
 * espejado, los permisos y el historial — y no existe un segundo camino de escritura que
 * pueda divergir del primero.
 *
 * ── Por qué `privateNote` y `applyLabels` son de primera clase ──────────────
 * Los agentes humanos trabajan DENTRO de Chatwoot, no en el inbox de Prominense (D11). Una
 * marca en nuestra base no la ve nadie. El rastro operativo del bot —qué hizo, o por qué se
 * frenó— tiene que quedar en Chatwoot o no existe.
 *
 * Todos los métodos son BEST-EFFORT desde el punto de vista del motor: si el label falla
 * después de que la respuesta salió, el motor no debe romperse (RUN-1).
 */
export interface AssistantConversationGateway {
  /** 🟡 `whatsapp_reply` — le habla AL CLIENTE. Sujeto a la ventana de 24 h (SEC-3). */
  reply(conversationId: string, text: string): Promise<void>;

  /**
   * 🟢 `private_note` — nota privada en Chatwoot: la ve el agente, el cliente NO. Es el canal
   * donde el bot explica qué hizo o por qué no pudo, sin obligar a nadie a cambiar de
   * herramienta. Funciona FUERA de la ventana de 24 h.
   */
  privateNote(conversationId: string, text: string): Promise<void>;

  /** 🟢 `apply_label` — `bot-respondió` / `necesita-humano`. Visible en la cola de Chatwoot. */
  applyLabels(conversationId: string, labels: string[]): Promise<void>;

  /** 🟢 `suggest_area` — reclasifica; deja evento `area_changed` en el historial (RTR-1). */
  setArea(conversationId: string, areaId: string): Promise<void>;

  /**
   * 🔴 `resolve_conversation` — marcar resuelta. Requiere eval registrado (EVAL-2): si el
   * pedido del cliente seguía vivo, esto entierra el reclamo y nadie se entera.
   */
  resolve(conversationId: string): Promise<void>;
}

/** Labels canónicos del rastro en Chatwoot (D11). No configurables: son el contrato visual. */
export const ASSISTANT_LABEL_REPLIED = 'bot-respondió';
export const ASSISTANT_LABEL_NEEDS_HUMAN = 'necesita-humano';
