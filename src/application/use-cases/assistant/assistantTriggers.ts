import type { AssistantIntent } from '@domain/entities/assistant';

/**
 * ai-assistant-cobranzas (3.3 / D5 / RTR-4) — pre-chequeo determinístico de `triggerPatterns`,
 * ANTES de `runtime.classify`. Función PURA: sin repos, sin modelo.
 *
 * Sólo evalúa intents `enabled` con `actionKey:'handoff'` — la restricción de guardar
 * `triggerPatterns` en otra `actionKey` la rechaza la capa de configuración (CFG-2
 * modificado), pero esta función es defensiva igual: nunca deja que una fila mal cargada
 * (por un bug o un dato viejo) intercepte una intención que sí debía redactar contenido.
 *
 * Cobrarle a un cliente sin servicio es el peor modo de falla del change (D5) y no puede
 * depender de que el clasificador acierte — por eso este chequeo corre ANTES, no reemplaza.
 */
export function matchTriggerIntent(
  lastCustomerText: string,
  intents: AssistantIntent[],
): AssistantIntent | null {
  for (const intent of intents) {
    if (!intent.enabled) continue;
    if (intent.actionKey !== 'handoff') continue;

    for (const pattern of intent.triggerPatterns) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch {
        // eslint-disable-next-line no-console
        console.warn(
          `matchTriggerIntent: triggerPattern inválido en la intent "${intent.name}" (${intent.id}): ${pattern}`,
        );
        continue;
      }

      if (regex.test(lastCustomerText)) return intent;
    }
  }

  return null;
}
