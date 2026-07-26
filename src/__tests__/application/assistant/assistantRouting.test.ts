import {
  resolveAssistantRouting,
  shouldAttemptReroute,
} from '@application/use-cases/assistant/assistantRouting';

/**
 * ai-assistant-multiagent (RTR-0) — el ruteo.
 *
 * Contexto de por qué existe: las conversaciones de WhatsApp entran con `areaId = NULL` y
 * nadie las clasifica (`SetConversationArea` vive en una UI que el equipo no usa). Sin agente
 * default, el motor jamás se activaría y la feature quedaría inerte en prod con la suite en
 * verde.
 */

describe('resolveAssistantRouting', () => {
  it('el área explícita gana: no se pisa la decisión de un humano', () => {
    expect(
      resolveAssistantRouting('area-facturacion', {
        defaultAreaId: 'area-soporte',
        rerouteEnabled: true,
      }),
    ).toEqual({ kind: 'area', areaId: 'area-facturacion', viaDefault: false });
  });

  it('sin área, atiende el agente default', () => {
    expect(
      resolveAssistantRouting(null, { defaultAreaId: 'area-soporte', rerouteEnabled: false }),
    ).toEqual({ kind: 'area', areaId: 'area-soporte', viaDefault: true });
  });

  it('sin área y SIN default ⇒ nadie atiende (silencio, no improvisación)', () => {
    expect(
      resolveAssistantRouting(null, { defaultAreaId: null, rerouteEnabled: false }),
    ).toEqual({ kind: 'none', reason: 'no_area_no_default' });
  });

  it('el seed deja defaultAreaId en null ⇒ instalación nueva no atiende nada', () => {
    // Un agente recién instalado no debe empezar a contestarle a todo el mundo por existir.
    expect(resolveAssistantRouting(null, { defaultAreaId: null, rerouteEnabled: true }).kind).toBe(
      'none',
    );
  });

  it('marca viaDefault para que el motor sepa si puede re-rutear', () => {
    const explicit = resolveAssistantRouting('area-1', {
      defaultAreaId: 'area-2',
      rerouteEnabled: true,
    });
    const fallback = resolveAssistantRouting(null, {
      defaultAreaId: 'area-2',
      rerouteEnabled: true,
    });

    expect(explicit).toMatchObject({ viaDefault: false });
    expect(fallback).toMatchObject({ viaDefault: true });
  });
});

describe('shouldAttemptReroute', () => {
  const base = { rerouteEnabled: true, viaDefault: true, classifiedOutOfScope: true };

  it('re-rutea cuando el default no supo qué hacer', () => {
    expect(shouldAttemptReroute(base)).toBe(true);
  });

  it('NO re-rutea si está deshabilitado', () => {
    expect(shouldAttemptReroute({ ...base, rerouteEnabled: false })).toBe(false);
  });

  it('NO re-rutea si el área la puso un humano', () => {
    // Reasignar acá sería pisarle la decisión a la persona que clasificó.
    expect(shouldAttemptReroute({ ...base, viaDefault: false })).toBe(false);
  });

  it('NO re-rutea si el default SÍ supo qué hacer', () => {
    // Si el tema cae en la allowlist del default, no hay nada que reasignar.
    expect(shouldAttemptReroute({ ...base, classifiedOutOfScope: false })).toBe(false);
  });
});
