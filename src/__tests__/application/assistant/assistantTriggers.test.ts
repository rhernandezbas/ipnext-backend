import { matchTriggerIntent } from '@application/use-cases/assistant/assistantTriggers';
import type { AssistantIntent } from '@domain/entities/assistant';

/**
 * ai-assistant-cobranzas (3.3 / D5 / RTR-4) — pre-chequeo determinístico de `triggerPatterns`,
 * ANTES de `runtime.classify`. Función pura: sin repos, sin modelo.
 */

function intent(overrides: Partial<AssistantIntent> = {}): AssistantIntent {
  return {
    id: 'intent-1',
    profileId: 'profile-1',
    name: 'reclamo_servicio',
    description: 'El cliente reporta que no tiene servicio',
    examples: [],
    enabled: true,
    dataSourceKeys: [],
    responseGuide: '',
    actionKey: 'handoff',
    labels: ['soporte'],
    triggerPatterns: ['no tengo (internet|servicio)'],
    unassign: false,
    roleKey: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('matchTriggerIntent', () => {
  it('RTR-4: "ya pagué y no tengo internet" matchea reclamo_servicio sin invocar al modelo', () => {
    const result = matchTriggerIntent('ya pagué y no tengo internet', [intent()]);

    expect(result?.name).toBe('reclamo_servicio');
  });

  it('sin match, devuelve null', () => {
    const result = matchTriggerIntent('¿cuánto debo?', [intent()]);

    expect(result).toBeNull();
  });

  it('una intent deshabilitada NO matchea aunque el patrón calce', () => {
    const result = matchTriggerIntent('no tengo internet', [intent({ enabled: false })]);

    expect(result).toBeNull();
  });

  it('RTR-4: una regex inválida se ignora con warn y no rompe la corrida', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = matchTriggerIntent('no tengo internet', [
      intent({ name: 'rota', triggerPatterns: ['(['] }),
      intent({ name: 'reclamo_servicio' }),
    ]);

    expect(result?.name).toBe('reclamo_servicio');
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('sólo evalúa intents con actionKey handoff (RTR-4/CFG-2)', () => {
    const result = matchTriggerIntent('no tengo internet', [
      intent({ actionKey: 'whatsapp_reply', triggerPatterns: [] }),
    ]);

    expect(result).toBeNull();
  });

  it('intent sin triggerPatterns nunca matchea', () => {
    const result = matchTriggerIntent('no tengo internet', [intent({ triggerPatterns: [] })]);

    expect(result).toBeNull();
  });

  it('el orden de las intents decide cuál gana si más de una matchea', () => {
    const first = intent({ name: 'primera', triggerPatterns: ['no tengo internet'] });
    const second = intent({ name: 'segunda', triggerPatterns: ['no tengo internet'] });

    const result = matchTriggerIntent('no tengo internet', [first, second]);

    expect(result?.name).toBe('primera');
  });

  it('es case-insensitive', () => {
    const result = matchTriggerIntent('NO TENGO INTERNET', [intent()]);

    expect(result?.name).toBe('reclamo_servicio');
  });
});
