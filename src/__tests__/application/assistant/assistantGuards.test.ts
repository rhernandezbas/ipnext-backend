import {
  evaluateActionPermission,
  evaluateAgentActivity,
  evaluateAssistantPreconditions,
} from '@application/use-cases/assistant/assistantGuards';
import type { AssistantThreadMessage } from '@domain/ports/AssistantThreadReader';

/**
 * ai-assistant-multiagent — las guardas del motor.
 *
 * Funciones puras: acá vive la mitad de la seguridad del sistema y se prueba en milisegundos,
 * sin repos, sin fixtures, sin modelo. Si algo de esto se rompe, el bot habla cuando no debe.
 */

const OK = {
  flagEnabled: true,
  direction: 'inbound' as const,
  isPrivate: false,
  profile: { enabled: true },
  optedOut: false,
};

describe('evaluateAssistantPreconditions', () => {
  it('deja pasar cuando todo está en orden', () => {
    expect(evaluateAssistantPreconditions(OK)).toMatchObject({ proceed: true, reason: null });
  });

  // ── RUN-4 ────────────────────────────────────────────────────────────────
  it('RUN-4: el flag global apagado corta todo', () => {
    expect(evaluateAssistantPreconditions({ ...OK, flagEnabled: false })).toMatchObject({
      proceed: false,
      reason: 'flag_off',
    });
  });

  it('RUN-4: el flag gana incluso con perfil habilitado y todo lo demás perfecto', () => {
    const result = evaluateAssistantPreconditions({ ...OK, flagEnabled: false });

    expect(result.proceed).toBe(false);
  });

  // ── SEC-2 · ANTI-LOOP ────────────────────────────────────────────────────
  it('SEC-2: el eco de la propia respuesta del bot (outbound) NO dispara el motor', () => {
    // Sin esta guarda, Chatwoot reenvía por webhook el mensaje que el bot acaba de mandar,
    // el motor lo procesa como si fuera nuevo y se alimenta a sí mismo.
    expect(evaluateAssistantPreconditions({ ...OK, direction: 'outbound' })).toMatchObject({
      proceed: false,
      reason: 'not_inbound',
    });
  });

  it('SEC-2: activity/template (direction null) tampoco dispara', () => {
    expect(evaluateAssistantPreconditions({ ...OK, direction: null })).toMatchObject({
      reason: 'not_inbound',
    });
  });

  it('SEC-2: una nota privada de un agente NO dispara', () => {
    expect(evaluateAssistantPreconditions({ ...OK, isPrivate: true })).toMatchObject({
      reason: 'private_note',
    });
  });

  // ── Perfil ───────────────────────────────────────────────────────────────
  it('área sin perfil ⇒ noop silencioso (es el estado normal de casi todas)', () => {
    expect(evaluateAssistantPreconditions({ ...OK, profile: null })).toMatchObject({
      proceed: false,
      reason: 'no_profile',
      outcome: 'noop',
    });
  });

  it('perfil apagado ⇒ noop, distinto de "no existe"', () => {
    expect(
      evaluateAssistantPreconditions({ ...OK, profile: { enabled: false } }),
    ).toMatchObject({ reason: 'profile_disabled' });
  });

  // ── SEC-5 ────────────────────────────────────────────────────────────────
  it('SEC-5: el opt-out tiene precedencia absoluta sobre la configuración', () => {
    expect(evaluateAssistantPreconditions({ ...OK, optedOut: true })).toMatchObject({
      proceed: false,
      reason: 'opt_out',
    });
  });

  // ── Semántica del outcome ────────────────────────────────────────────────
  it('todo lo que rebota acá es `noop`, nunca `handoff`', () => {
    // noop = "ni siquiera era para mí". handoff = "corrí y decidí callar" (y deja rastro).
    for (const input of [
      { ...OK, flagEnabled: false },
      { ...OK, direction: 'outbound' as const },
      { ...OK, isPrivate: true },
      { ...OK, profile: null },
      { ...OK, optedOut: true },
    ]) {
      expect(evaluateAssistantPreconditions(input).outcome).toBe('noop');
    }
  });

  it('el orden corta barato: con el flag apagado no importa nada más', () => {
    const result = evaluateAssistantPreconditions({
      flagEnabled: false,
      direction: 'outbound',
      isPrivate: true,
      profile: null,
      optedOut: true,
    });

    expect(result.reason).toBe('flag_off');
  });
});

describe('evaluateActionPermission', () => {
  it('ACT-1: una acción no habilitada en el perfil se rechaza', () => {
    expect(
      evaluateActionPermission({
        actionKey: 'resolve_conversation',
        enabledActions: ['whatsapp_reply'],
        canReply: true,
      }),
    ).toMatchObject({ allowed: false, reason: 'action_not_enabled' });
  });

  it('ACT-1: una acción habilitada se permite', () => {
    expect(
      evaluateActionPermission({
        actionKey: 'whatsapp_reply',
        enabledActions: ['whatsapp_reply'],
        canReply: true,
      }),
    ).toMatchObject({ allowed: true });
  });

  // ── SEC-3 ────────────────────────────────────────────────────────────────
  it('SEC-3: fuera de la ventana de 24 h no se le escribe al cliente', () => {
    expect(
      evaluateActionPermission({
        actionKey: 'whatsapp_reply',
        enabledActions: ['whatsapp_reply'],
        canReply: false,
      }),
    ).toMatchObject({ allowed: false, reason: 'outside_reply_window' });
  });

  it('SEC-3: la nota privada SÍ funciona fuera de ventana', () => {
    // Es la clave: fuera de ventana el bot no puede hablarle al cliente, pero sí avisarle al
    // humano. Cortar todo en la puerta perdería justo el aviso que más importa.
    expect(
      evaluateActionPermission({
        actionKey: 'private_note',
        enabledActions: ['private_note'],
        canReply: false,
      }),
    ).toMatchObject({ allowed: true });
  });

  it('SEC-3: etiquetar también funciona fuera de ventana', () => {
    expect(
      evaluateActionPermission({
        actionKey: 'apply_label',
        enabledActions: ['apply_label'],
        canReply: false,
      }),
    ).toMatchObject({ allowed: true });
  });

  it('ACT-1 gana sobre SEC-3: si no está habilitada, la ventana ni se evalúa', () => {
    expect(
      evaluateActionPermission({
        actionKey: 'whatsapp_reply',
        enabledActions: [],
        canReply: false,
      }),
    ).toMatchObject({ reason: 'action_not_enabled' });
  });

  it('perfil sin ninguna acción habilitada no puede hacer nada', () => {
    for (const key of ['whatsapp_reply', 'private_note', 'apply_label', 'suggest_area']) {
      expect(
        evaluateActionPermission({ actionKey: key, enabledActions: [], canReply: true }).allowed,
      ).toBe(false);
    }
  });
});

// ── SEC-6 (ai-assistant-cobranzas, D4) — guarda "agente activo" ───────────────
describe('evaluateAgentActivity', () => {
  function msg(overrides: Partial<AssistantThreadMessage> = {}): AssistantThreadMessage {
    return { role: 'customer', text: '', generatedByAssistant: false, attachmentFilenames: [], ...overrides };
  }

  /** ai-assistant-cobranzas (fix wave W1) — instante fijo para la ventana de SEC-6. */
  const NOW = new Date('2026-09-05T12:00:00.000Z');
  const iso = (minutos: number) => new Date(NOW.getTime() + minutos * 60_000).toISOString();

  it('SEC-6: un agente humano respondió DESPUÉS del último customer ⇒ stop(agent_active)', () => {
    const thread = [
      msg({ role: 'customer', text: '¿cuánto debo?' }),
      msg({ role: 'agent', text: 'ya te ayudo yo', generatedByAssistant: false }),
    ];

    expect(evaluateAgentActivity(thread)).toMatchObject({ proceed: false, reason: 'agent_active' });
  });

  // ── Fix wave W1 — la guarda es por VENTANA, no por ordenamiento de turnos ──
  // El orden no protege: si el agente contesta y el cliente vuelve a escribir, el índice del
  // "último customer" se corre y la guarda pasaba — el bot hablaba encima de un humano que
  // había respondido hace 30 segundos.
  it('W1: un agente humano respondió ANTES del último customer pero DENTRO de la ventana ⇒ stop', () => {
    const thread = [
      msg({ role: 'agent', text: 'dale, avisame', generatedByAssistant: false, at: iso(-2) }),
      msg({ role: 'customer', text: 'listo, ya te mando el comprobante', at: iso(-1) }),
    ];

    expect(evaluateAgentActivity(thread, { now: NOW })).toMatchObject({
      proceed: false,
      reason: 'agent_active',
    });
  });

  it('W1: un agente humano FUERA de la ventana (hace 3 h) ⇒ continúa', () => {
    const thread = [
      msg({ role: 'agent', text: 'dale, avisame', generatedByAssistant: false, at: iso(-180) }),
      msg({ role: 'customer', text: 'listo, ya te mando el comprobante', at: iso(-1) }),
    ];

    expect(evaluateAgentActivity(thread, { now: NOW })).toMatchObject({ proceed: true });
  });

  it('W1: la ventana es configurable — con 240 min, el mismo turno de hace 3 h sí frena', () => {
    const thread = [
      msg({ role: 'agent', text: 'dale, avisame', generatedByAssistant: false, at: iso(-180) }),
      msg({ role: 'customer', text: 'listo', at: iso(-1) }),
    ];

    expect(evaluateAgentActivity(thread, { now: NOW, windowMinutes: 240 })).toMatchObject({
      proceed: false,
      reason: 'agent_active',
    });
  });

  it('W1: turno de agente humano SIN timestamp ⇒ ACTIVO (fail-closed)', () => {
    const thread = [
      msg({ role: 'agent', text: 'ya te ayudo', generatedByAssistant: false }),
      msg({ role: 'customer', text: 'gracias', at: iso(-1) }),
    ];

    expect(evaluateAgentActivity(thread, { now: NOW })).toMatchObject({
      proceed: false,
      reason: 'agent_active',
    });
  });

  it('W1: un turno del BOT dentro de la ventana NO cuenta, tenga o no timestamp', () => {
    const thread = [
      msg({ role: 'agent', text: 'tu saldo es...', generatedByAssistant: true, at: iso(-1) }),
      msg({ role: 'agent', text: 'algo más', generatedByAssistant: true }),
      msg({ role: 'customer', text: '¿y las facturas?', at: iso(0) }),
    ];

    expect(evaluateAgentActivity(thread, { now: NOW })).toMatchObject({ proceed: true });
  });

  it('un turno del propio bot (generatedByAssistant:true) NO cuenta como agente activo', () => {
    const thread = [
      msg({ role: 'customer', text: '¿cuánto debo?' }),
      msg({ role: 'agent', text: 'tu saldo es...', generatedByAssistant: true }),
    ];

    expect(evaluateAgentActivity(thread)).toMatchObject({ proceed: true });
  });

  it('sin señales de actividad humana, la guarda no frena la corrida', () => {
    const thread = [msg({ role: 'customer', text: 'hola' })];

    expect(evaluateAgentActivity(thread)).toMatchObject({ proceed: true, reason: null });
  });

  it('hilo vacío no rompe la guarda', () => {
    expect(evaluateAgentActivity([])).toMatchObject({ proceed: true });
  });

  it('todo lo que rebota acá es reason=agent_active, un identificador fijo sin texto del cliente (OBS-3)', () => {
    const thread = [
      msg({ role: 'customer', text: 'información sensible del cliente' }),
      msg({ role: 'agent', text: 'otra información', generatedByAssistant: false }),
    ];

    const result = evaluateAgentActivity(thread);

    expect(result.reason).toBe('agent_active');
    expect(JSON.stringify(result)).not.toContain('información');
  });
});
