import type { AssistantOutcome } from '@domain/entities/assistant';
import type { AssistantThreadMessage } from '@domain/ports/AssistantThreadReader';

/**
 * ai-assistant-multiagent (SEC-2/SEC-3/SEC-5/RUN-4/ACT-1) — guardas del motor.
 *
 * Funciones PURAS, sin repos y sin modelo. Acá vive la mitad de la seguridad del sistema y
 * por eso está aislada: se testea exhaustivamente y en milisegundos, sin fixtures ni mocks.
 *
 * Ninguna de estas reglas es configurable desde la UI (proposal R5): el operador afina el
 * tono, jamás toca el límite.
 */

/** Motivo corto y ACOTADO — va a `AssistantRun.reason`. Nunca lleva contenido del cliente. */
export type AssistantSkipReason =
  | 'flag_off'
  | 'not_inbound'
  | 'private_note'
  | 'no_profile'
  | 'profile_disabled'
  | 'opt_out'
  // ai-assistant-cobranzas (D4/SEC-6/OBS-3) — un agente humano ya está en la conversación.
  | 'agent_active';

export interface AssistantPreconditionInput {
  /** RUN-4 — kill-switch global, leído POR INVOCACIÓN (no cacheado al boot). */
  flagEnabled: boolean;
  /** SEC-2 — `null` para activity/template: nunca se espejan, nunca disparan el motor. */
  direction: 'inbound' | 'outbound' | null;
  /** SEC-2 — nota interna de un agente. */
  isPrivate: boolean;
  /** `null` = el área no tiene agente configurado (estado normal de casi todas). */
  profile: { enabled: boolean } | null;
  /** SEC-5 — el cliente pidió la baja del canal (BAJA/STOP). */
  optedOut: boolean;
}

export interface AssistantPreconditionResult {
  proceed: boolean;
  reason: AssistantSkipReason | null;
  /** `noop` = ni siquiera debía correr. Se distingue de `handoff` (corrió y decidió callar). */
  outcome: Extract<AssistantOutcome, 'noop'> | null;
}

const CONTINUE: AssistantPreconditionResult = { proceed: true, reason: null, outcome: null };

const stop = (reason: AssistantSkipReason): AssistantPreconditionResult => ({
  proceed: false,
  reason,
  outcome: 'noop',
});

/**
 * Decide si el motor debe correr siquiera. Todo lo que rebota acá es `noop`, NO `handoff`:
 * un handoff significa "corrí y decidí no contestar" (y deja rastro en Chatwoot); un noop
 * significa "esto ni siquiera era para mí".
 *
 * El ORDEN importa por costo: lo más barato y más frecuente primero, para no gastar una
 * consulta de perfil ni una llamada al modelo en el eco de nuestro propio mensaje.
 */
export function evaluateAssistantPreconditions(
  input: AssistantPreconditionInput,
): AssistantPreconditionResult {
  const entry = evaluateEntryPreconditions(input);
  if (!entry.proceed) return entry;

  return evaluateProfilePreconditions(input);
}

/**
 * Etapa 1 — checks BARATOS, sin una sola consulta a la base.
 *
 * Están separados de la etapa 2 por costo, no por elegancia: el eco `message_created` de cada
 * respuesta del bot vuelve por el webhook, y resolver ruteo + perfil + cliente para descartarlo
 * serían 3 queries desperdiciadas **por cada mensaje que el bot manda**. A escala, eso es el
 * doble de carga por una respuesta que ya dimos.
 */
export function evaluateEntryPreconditions(
  input: Pick<AssistantPreconditionInput, 'flagEnabled' | 'direction' | 'isPrivate'>,
): AssistantPreconditionResult {
  // RUN-4 — kill-switch global. Primero: es un booleano y corta todo.
  if (!input.flagEnabled) return stop('flag_off');

  // SEC-2 — ANTI-LOOP. Sin esto, el eco `message_created` de la propia respuesta del bot lo
  // vuelve a disparar y se alimenta a sí mismo hasta agotar la cuota o el hilo.
  if (input.direction !== 'inbound') return stop('not_inbound');
  if (input.isPrivate) return stop('private_note');

  return CONTINUE;
}

/** Etapa 2 — requiere haber resuelto el perfil del área y la identidad del cliente. */
export function evaluateProfilePreconditions(
  input: Pick<AssistantPreconditionInput, 'profile' | 'optedOut'>,
): AssistantPreconditionResult {
  // Sin perfil o apagado ⇒ el área no tiene agente. Es el estado normal de casi todas.
  if (!input.profile) return stop('no_profile');
  if (!input.profile.enabled) return stop('profile_disabled');

  // SEC-5 — precedencia ABSOLUTA: da igual qué diga la configuración del perfil.
  if (input.optedOut) return stop('opt_out');

  return CONTINUE;
}

/** ai-assistant-cobranzas (fix wave W1) — ventana por defecto de "hay un humano atendiendo". */
export const DEFAULT_AGENT_ACTIVE_WINDOW_MINUTES = 60;

export interface AgentActivityOptions {
  /** Instante de evaluación. Inyectable para testear la ventana sin relojes falsos globales. */
  now?: Date;
  /** Minutos hacia atrás que cuentan como "un humano está atendiendo". Default: 60. */
  windowMinutes?: number;
}

/**
 * ai-assistant-cobranzas (3.4 / D4 / SEC-6, reescrita en el fix wave W1) — guarda "agente
 * activo": no responder encima de un humano.
 *
 * `stop('agent_active')` si existe CUALQUIER turno `role:'agent'` con
 * `generatedByAssistant:false` dentro de la VENTANA (default 60 min), sin importar el orden
 * de los turnos.
 *
 * ⚠️ **Por qué el orden no alcanzaba.** La versión original sólo miraba los turnos POSTERIORES
 * al último `customer`. Si el agente contestaba y el cliente volvía a escribir, el índice se
 * corría y la guarda pasaba: el bot le hablaba encima a una persona que había respondido hace
 * 30 segundos. El orden de los turnos no dice nada sobre si hay alguien atendiendo AHORA — eso
 * lo dice el reloj.
 *
 * **Sin `at` ⇒ ACTIVO (fail-closed).** Un turno de agente humano sin timestamp no se puede
 * ubicar en el tiempo, y la asimetría de esta señal es total: callarse de más cuesta un
 * silencio recuperable; hablar de más interrumpe a una persona frente a un cliente.
 *
 * Función PURA sobre el hilo que el motor YA carga (`readRecentTurns`) — cero queries nuevas,
 * cero puerto nuevo. `generatedByAssistant` NUNCA llega al prompt del modelo: sólo esta guarda
 * lo consume (D4).
 */
export function evaluateAgentActivity(
  thread: AssistantThreadMessage[],
  options: AgentActivityOptions = {},
): AssistantPreconditionResult {
  const now = (options.now ?? new Date()).getTime();
  const windowMs = Math.max(0, options.windowMinutes ?? DEFAULT_AGENT_ACTIVE_WINDOW_MINUTES) * 60_000;

  const humanActive = thread.some(
    (m) => m.role === 'agent' && !m.generatedByAssistant && isWithinWindow(m.at, now, windowMs),
  );

  return humanActive ? stop('agent_active') : CONTINUE;
}

/** `null`/ausente/ilegible ⇒ `true`: la ausencia de dato NUNCA apaga una guarda de seguridad. */
function isWithinWindow(at: string | null | undefined, now: number, windowMs: number): boolean {
  if (typeof at !== 'string' || at.trim().length === 0) return true;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return true;
  return now - ms <= windowMs;
}

export interface ActionPermissionInput {
  actionKey: string;
  /** ACT-1 — acciones habilitadas EN ESTE perfil. */
  enabledActions: string[];
  /** SEC-3 — ventana de 24 h de WhatsApp, leída del mirror (nunca recalculada). */
  canReply: boolean;
}

/** Acciones que le hablan AL CLIENTE — sujetas a la ventana de 24 h (SEC-3). */
const CUSTOMER_FACING_ACTIONS = new Set(['whatsapp_reply', 'comment_public']);

export type ActionDenialReason = 'action_not_enabled' | 'outside_reply_window';

/**
 * ACT-1 + SEC-3 — ¿se puede ejecutar esta acción, en este perfil, ahora?
 *
 * La ventana de 24 h se chequea acá y no en las precondiciones a propósito: fuera de ventana
 * el bot NO puede escribirle al cliente, pero SÍ puede dejar una nota privada o etiquetar la
 * conversación para que un humano la vea. Cortar todo en la puerta de entrada perdería
 * justamente el aviso que más importa cuando el bot no puede responder.
 */
export function evaluateActionPermission(
  input: ActionPermissionInput,
): { allowed: boolean; reason: ActionDenialReason | null } {
  if (!input.enabledActions.includes(input.actionKey)) {
    return { allowed: false, reason: 'action_not_enabled' };
  }

  if (CUSTOMER_FACING_ACTIONS.has(input.actionKey) && !input.canReply) {
    return { allowed: false, reason: 'outside_reply_window' };
  }

  return { allowed: true, reason: null };
}
