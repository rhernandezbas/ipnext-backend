/**
 * ai-assistant-cobranzas (2.1/2.5) — RED: `AssistantIntent` gana `labels`/`triggerPatterns`
 * (D2/D5) y, en la enmienda D9–D11, `unassign`/`roleKey` (D10/D11).
 *
 * Compilation-only test (molde `entities/project.test.ts`): si el campo falta en la
 * interfaz, `ts-jest` no compila este archivo y el test queda en rojo.
 */
import { AssistantIntent } from '../../../domain/entities/assistant';

describe('AssistantIntent entity — labels y triggerPatterns (D2/D5)', () => {
  it('acepta labels y triggerPatterns como arrays de strings', () => {
    const intent: AssistantIntent = {
      id: 'intent-1',
      profileId: 'profile-1',
      name: 'reclamo_servicio',
      description: 'El cliente reporta que no tiene servicio',
      examples: ['no tengo internet'],
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
    };

    expect(intent.labels).toEqual(['soporte']);
    expect(intent.triggerPatterns).toEqual(['no tengo (internet|servicio)']);
  });

  it('labels y triggerPatterns pueden nacer vacíos (default del schema)', () => {
    const intent: AssistantIntent = {
      id: 'intent-2',
      profileId: 'profile-1',
      name: 'estado de cuenta',
      description: 'El cliente pregunta cuánto debe',
      examples: [],
      enabled: true,
      dataSourceKeys: ['cliente.saldo'],
      responseGuide: '',
      actionKey: 'whatsapp_reply',
      labels: [],
      triggerPatterns: [],
      unassign: false,
      roleKey: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    expect(intent.labels).toEqual([]);
    expect(intent.triggerPatterns).toEqual([]);
  });

  it('acepta unassign:true y roleKey (D10/D11)', () => {
    const intent: AssistantIntent = {
      id: 'intent-3',
      profileId: 'profile-1',
      name: 'promesa_pago',
      description: 'El cliente promete pagar más tarde',
      examples: [],
      enabled: true,
      dataSourceKeys: [],
      responseGuide: '',
      actionKey: 'handoff',
      labels: ['administracion'],
      triggerPatterns: ['te pago el lunes'],
      unassign: true,
      roleKey: 'promesa_pago',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    expect(intent.unassign).toBe(true);
    expect(intent.roleKey).toBe('promesa_pago');
  });

  it('unassign y roleKey pueden nacer en false/null (default del schema)', () => {
    const intent: AssistantIntent = {
      id: 'intent-4',
      profileId: 'profile-1',
      name: 'estado de cuenta',
      description: 'El cliente pregunta cuánto debe',
      examples: [],
      enabled: true,
      dataSourceKeys: ['cliente.saldo'],
      responseGuide: '',
      actionKey: 'whatsapp_reply',
      labels: [],
      triggerPatterns: [],
      unassign: false,
      roleKey: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };

    expect(intent.unassign).toBe(false);
    expect(intent.roleKey).toBeNull();
  });
});
