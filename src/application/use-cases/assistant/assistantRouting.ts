import type { AssistantRoutingConfig } from '@domain/ports/AssistantRoutingConfigRepository';

/**
 * ai-assistant-multiagent (RTR-0) — a qué área le toca esta conversación.
 *
 * Función PURA. Existe porque las conversaciones de WhatsApp entran con `areaId = NULL`
 * (nadie las clasifica: la herramienta vive en una UI que el equipo no usa), así que sin
 * agente default el motor nunca se activaría.
 */

export type AssistantRoutingResolution =
  | { kind: 'area'; areaId: string; viaDefault: boolean }
  | { kind: 'none'; reason: 'no_area_no_default' };

export function resolveAssistantRouting(
  conversationAreaId: string | null,
  routing: AssistantRoutingConfig,
): AssistantRoutingResolution {
  // El área explícita SIEMPRE gana: si un humano la clasificó, su decisión no se pisa.
  if (conversationAreaId) {
    return { kind: 'area', areaId: conversationAreaId, viaDefault: false };
  }

  if (routing.defaultAreaId) {
    return { kind: 'area', areaId: routing.defaultAreaId, viaDefault: true };
  }

  // Sin área y sin default ⇒ nadie atiende. Silencio, no improvisación.
  return { kind: 'none', reason: 'no_area_no_default' };
}

/**
 * ¿Corresponde intentar el re-ruteo?
 *
 * Sólo cuando: está habilitado, la conversación llegó SIN área (si un humano ya la clasificó,
 * reasignar sería pisarle la decisión), y el agente default no supo qué hacer con el tema.
 */
export function shouldAttemptReroute(input: {
  rerouteEnabled: boolean;
  viaDefault: boolean;
  classifiedOutOfScope: boolean;
}): boolean {
  return input.rerouteEnabled && input.viaDefault && input.classifiedOutOfScope;
}
