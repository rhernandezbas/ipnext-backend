import type { ConversationEventType } from '@domain/ports/ConversationEventRepository';

/**
 * conversation-events (Ola 2) — lógica PURA de la transición de estado de una conversación,
 * compartida por `SetConversationStatus` (acción del agente) y el webhook
 * `conversation_status_changed` (Chatwoot-driven). Decide, a partir del estado PREVIO y el
 * NUEVO, qué timestamps derivados escribir y qué evento emitir.
 *
 * Sólo dos transiciones REALES importan (`prev !== next`):
 *   - RESOLVER  (next==='resolved' y prev!=='resolved'): `resolvedAt = now`,
 *     `firstResolvedAt = prevFirstResolvedAt ?? now` (set-once), evento 'resolved'.
 *   - REABRIR   (prev==='resolved' y next!=='resolved'): `resolvedAt = null`,
 *     `firstResolvedAt` INTACTO, evento 'reopened'.
 * Cualquier otro cambio (open→pending, resolved→resolved idempotente, etc.) NO toca los
 * timestamps ni emite evento.
 *
 * El guard `prev !== next` es TAMBIÉN lo que hace idempotente/echo-safe al webhook: cuando
 * `SetConversationStatus` resuelve vía Chatwoot, Chatwoot reenvía un `conversation_status_changed`
 * de eco; para entonces el mirror YA está en 'resolved' (el upsert corrió antes del eco), así
 * que el webhook ve prev===next → no re-emite el evento ni re-escribe resolvedAt (sin duplicados).
 */
export interface StatusTransitionResult {
  /** Cambios a mergear en el upsert del mirror. Campos ausentes = no tocar. */
  patch: { resolvedAt?: string | null; firstResolvedAt?: string | null };
  /** Evento a registrar (best-effort), o `null` si no hubo transición real de resolución. */
  event: { type: Extract<ConversationEventType, 'resolved' | 'reopened'>; fromValue: string; toValue: string } | null;
}

export function computeStatusTransition(
  prevStatus: string,
  nextStatus: string,
  prevFirstResolvedAt: string | null,
  nowIso: string,
): StatusTransitionResult {
  const isResolving = nextStatus === 'resolved' && prevStatus !== 'resolved';
  const isReopening = prevStatus === 'resolved' && nextStatus !== 'resolved';

  if (isResolving) {
    return {
      patch: { resolvedAt: nowIso, firstResolvedAt: prevFirstResolvedAt ?? nowIso },
      event: { type: 'resolved', fromValue: prevStatus, toValue: nextStatus },
    };
  }
  if (isReopening) {
    return {
      // firstResolvedAt NO se toca (undefined = intacto) — la primera resolución es permanente.
      patch: { resolvedAt: null },
      event: { type: 'reopened', fromValue: prevStatus, toValue: nextStatus },
    };
  }
  return { patch: {}, event: null };
}
