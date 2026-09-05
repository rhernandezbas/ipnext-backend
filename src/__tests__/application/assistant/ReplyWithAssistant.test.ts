import {
  ReplyWithAssistant,
  type ReplyWithAssistantCommand,
} from '@application/use-cases/assistant/ReplyWithAssistant';
import { ResolveAssistantFacts } from '@application/use-cases/assistant/ResolveAssistantFacts';
import {
  InMemoryAssistantIntentRepository,
  InMemoryAssistantProfileRepository,
} from '@infrastructure/adapters/in-memory/InMemoryAssistantProfileRepository';
import { InMemoryAssistantCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantCatalogRepository';
import { InMemoryAssistantRunRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantRunRepository';
import { InMemoryAssistantRoutingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantRoutingConfigRepository';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { AssistantThreadMessage, AssistantThreadReader } from '@domain/ports/AssistantThreadReader';
import type { AssistantClientResolver } from '@domain/ports/AssistantClientResolver';
import type {
  AssistantClassifyResult,
  AssistantGenerateResult,
  AssistantRuntime,
} from '@domain/ports/AssistantRuntime';
import type { AssistantConversationGateway } from '@domain/ports/AssistantConversationGateway';
import type { AssistantDataSourceRegistry } from '@domain/ports/AssistantDataSourceRegistry';

/**
 * ai-assistant-multiagent — EL MOTOR, end-to-end con adapters in-memory.
 *
 * Este es el test más importante del change: recorre el pipeline REAL de 7 etapas sin mockear
 * los use cases del medio (lección #28/#27 — los tests por capa dan verde con la feature rota).
 * Lo único falso es el modelo, que es justamente lo que no se puede testear de verdad.
 */

class SpyGateway implements AssistantConversationGateway {
  replies: string[] = [];
  notes: string[] = [];
  labels: string[][] = [];
  areas: string[] = [];
  resolved = 0;

  async reply(_c: string, text: string) {
    this.replies.push(text);
  }
  async privateNote(_c: string, text: string) {
    this.notes.push(text);
  }
  async applyLabels(_c: string, labels: string[]) {
    this.labels.push(labels);
  }
  async setArea(_c: string, areaId: string) {
    this.areas.push(areaId);
  }
  async resolve() {
    this.resolved += 1;
  }
  /** ai-assistant-cobranzas (D10/ACT-4) — ripple compat; ejercitado de verdad en Lote G2 (5.8/5.9). */
  unassignCount = 0;
  async unassign() {
    this.unassignCount += 1;
  }
  /** Todos los labels aplicados, aplanados. */
  get allLabels(): string[] {
    return this.labels.flat();
  }
}

interface HarnessOptions {
  flagEnabled?: boolean;
  defaultAreaId?: string | null;
  rerouteEnabled?: boolean;
  profileEnabled?: boolean;
  enabledActions?: string[];
  optedOut?: boolean;
  classify?: AssistantClassifyResult;
  generate?: AssistantGenerateResult;
  /**
   * fix wave 2 (N3) — espía de los HECHOS que realmente llegan al modelo. Es el único lugar
   * donde se puede probar que un hecho interno (`_`) no se filtró: el objeto que ve `generate`
   * es exactamente el que viaja al prompt y el que alimenta el whitelist de SEC-4.
   */
  onGenerate?: (facts: Record<string, unknown> | null) => void;
  facts?: Record<string, unknown>;
  customerText?: string;
  intentActionKey?: string;
  // ── ai-assistant-cobranzas ────────────────────────────────────────────────
  /** D5/RTR-4 — patterns de la intent de STOP `reclamo_servicio` (siempre `handoff`). */
  stopTriggerPatterns?: string[];
  /** D2/ACT-3 — labels de la intent de STOP. */
  stopLabels?: string[];
  /** D4/SEC-6 — el hilo tal cual, para ejercitar la guarda de agente activo. */
  thread?: AssistantThreadMessage[];
  /** D11 — adjuntos del último inbound (`comprobante_<op>.pdf`). */
  attachmentFilenames?: string[];
  /** Hechos por fuente, para las fuentes de cobranza (D8/D9). */
  factsByKey?: Record<string, Record<string, unknown>>;
  /** D2/D10 — labels y unassign de la intent principal. */
  intentLabels?: string[];
  intentUnassign?: boolean;
  /** D11 — qué intents de rol existen y están habilitadas en el perfil. */
  roleIntents?: Array<{
    roleKey: string;
    actionKey?: string;
    labels?: string[];
    unassign?: boolean;
    dataSourceKeys?: string[];
    triggerPatterns?: string[];
    enabled?: boolean;
  }>;
}

async function harness(opts: HarnessOptions = {}) {
  const profiles = new InMemoryAssistantProfileRepository();
  const intents = new InMemoryAssistantIntentRepository();
  const catalog = new InMemoryAssistantCatalogRepository();
  const runs = new InMemoryAssistantRunRepository();
  const routing = new InMemoryAssistantRoutingConfigRepository();
  const gateway = new SpyGateway();

  const profile = await profiles.create({ areaId: 'area-1', persona: 'Cordial y breve' });
  await profiles.update(profile.id, {
    enabled: opts.profileEnabled ?? true,
    enabledActions: opts.enabledActions ?? ['whatsapp_reply', 'private_note', 'apply_label'],
  });
  const intent = await intents.create({
    profileId: profile.id,
    name: 'estado de cuenta',
    description: 'el cliente pregunta cuánto debe',
    dataSourceKeys: opts.factsByKey ? Object.keys(opts.factsByKey) : ['cliente.saldo'],
    actionKey: opts.intentActionKey ?? 'whatsapp_reply',
    labels: opts.intentLabels,
    unassign: opts.intentUnassign,
  });

  // D5/RTR-4 — la intent de STOP. Sólo intercepta si le cargan `triggerPatterns`.
  const stopIntent = await intents.create({
    profileId: profile.id,
    name: 'reclamo_servicio',
    description: 'el cliente dice que no tiene servicio',
    dataSourceKeys: [],
    actionKey: 'handoff',
    labels: opts.stopLabels ?? ['soporte'],
    triggerPatterns: opts.stopTriggerPatterns ?? [],
  });

  // D11 — las intents por `roleKey` del selector determinístico (4b).
  const roleIntents: Record<string, Awaited<ReturnType<typeof intents.create>>> = {};
  for (const r of opts.roleIntents ?? []) {
    roleIntents[r.roleKey] = await intents.create({
      profileId: profile.id,
      name: r.roleKey,
      description: r.roleKey,
      dataSourceKeys: r.dataSourceKeys ?? [],
      actionKey: r.actionKey ?? 'private_note',
      labels: r.labels ?? [],
      unassign: r.unassign ?? false,
      triggerPatterns: r.triggerPatterns ?? [],
      roleKey: r.roleKey,
      enabled: r.enabled ?? true,
    });
  }

  await routing.update({
    defaultAreaId: opts.defaultAreaId === undefined ? null : opts.defaultAreaId,
    rerouteEnabled: opts.rerouteEnabled ?? false,
  });

  const flags: FeatureFlagRepository = {
    list: async () => [],
    get: async (key) => ({ key, enabled: opts.flagEnabled ?? true, updatedAt: '' }) as never,
    setEnabled: async () => ({}) as never,
  };

  const threadReader: AssistantThreadReader = {
    readRecentTurns: async () =>
      opts.thread ?? [
        {
          role: 'customer',
          text: opts.customerText ?? '¿cuánto debo?',
          generatedByAssistant: false,
          attachmentFilenames: opts.attachmentFilenames ?? [],
        },
      ],
  };

  const clients: AssistantClientResolver = {
    resolveByPhone: async () => ({
      clientId: 'client-1',
      optedOut: opts.optedOut ?? false,
      identityValues: ['Juan Pérez'],
    }),
  };

  const byKey: Record<string, Record<string, unknown>> = opts.factsByKey ?? {
    'cliente.saldo': opts.facts ?? { saldo: 45000 },
  };
  const registry: AssistantDataSourceRegistry = {
    get: (key) => (byKey[key] ? { key, resolve: async () => byKey[key] } : null),
    keys: () => Object.keys(byKey),
  };

  const runtime: AssistantRuntime = {
    classify: async () => opts.classify ?? { kind: 'intent', key: intent.id },
    generate: async (input) => {
      opts.onGenerate?.(input.facts as Record<string, unknown> | null);
      return opts.generate ?? { kind: 'text', text: 'Tu saldo es $45000.' };
    },
  };

  const useCase = new ReplyWithAssistant(
    flags,
    routing,
    profiles,
    intents,
    threadReader,
    clients,
    new ResolveAssistantFacts(catalog, registry),
    runtime,
    gateway,
    runs,
  );

  return { useCase, gateway, runs, profiles, intents, profile, intent, stopIntent, roleIntents, routing };
}

const CMD: ReplyWithAssistantCommand = {
  conversationId: 'conv-1',
  areaId: 'area-1',
  direction: 'inbound',
  isPrivate: false,
  canReply: true,
  contactPhone: '+5492964123456',
  // ai-assistant-cobranzas (D4.2/SEC-6) — quién tiene la conversación EN CHATWOOT, del
  // payload que dispara la corrida. `null` = sin asignar.
  assigneeName: null,
};

describe('ReplyWithAssistant — camino feliz', () => {
  it('responde al cliente y etiqueta la conversación', async () => {
    const { useCase, gateway } = await harness();

    await expect(useCase.execute(CMD)).resolves.toBe('replied');

    expect(gateway.replies).toEqual(['Tu saldo es $45000.']);
    expect(gateway.allLabels).toContain('bot-respondió');
  });

  it('OBS-1: registra la corrida con intención, fuentes y acción', async () => {
    const { useCase, runs } = await harness();

    await useCase.execute(CMD);

    const { items } = await runs.list({});
    expect(items[0]).toMatchObject({
      outcome: 'replied',
      intentName: 'estado de cuenta',
      dataSources: ['cliente.saldo'],
      actionKey: 'whatsapp_reply',
    });
  });
});

describe('ReplyWithAssistant — noop (ni siquiera era para mí)', () => {
  it('RUN-4: flag global apagado', async () => {
    const { useCase, gateway } = await harness({ flagEnabled: false });

    await expect(useCase.execute(CMD)).resolves.toBe('noop');
    expect(gateway.replies).toEqual([]);
  });

  it('SEC-2: el eco outbound del propio bot NO dispara nada', async () => {
    const { useCase, gateway } = await harness();

    await expect(useCase.execute({ ...CMD, direction: 'outbound' })).resolves.toBe('noop');
    expect(gateway.replies).toEqual([]);
  });

  it('SEC-2: una nota privada de un agente NO dispara', async () => {
    const { useCase, gateway } = await harness();

    await expect(useCase.execute({ ...CMD, isPrivate: true })).resolves.toBe('noop');
    expect(gateway.replies).toEqual([]);
  });

  it('SEC-5: cliente en opt-out — no se le manda NADA', async () => {
    const { useCase, gateway } = await harness({ optedOut: true });

    await expect(useCase.execute(CMD)).resolves.toBe('noop');
    expect(gateway.replies).toEqual([]);
    expect(gateway.notes).toEqual([]);
  });

  it('perfil apagado', async () => {
    const { useCase, gateway } = await harness({ profileEnabled: false });

    await expect(useCase.execute(CMD)).resolves.toBe('noop');
    expect(gateway.replies).toEqual([]);
  });

  // ── RTR-0: el hallazgo del areaId NULL ──────────────────────────────────
  it('RTR-0: conversación SIN área y SIN default ⇒ silencio', async () => {
    const { useCase, gateway } = await harness({ defaultAreaId: null });

    await expect(useCase.execute({ ...CMD, areaId: null })).resolves.toBe('noop');
    expect(gateway.replies).toEqual([]);
  });

  it('RTR-0: conversación SIN área CON default ⇒ atiende el agente default', async () => {
    // Sin esto la feature quedaría inerte: los WhatsApp entran con areaId NULL y nadie
    // los clasifica (SetConversationArea vive en una UI que el equipo no usa).
    const { useCase, gateway } = await harness({ defaultAreaId: 'area-1' });

    await expect(useCase.execute({ ...CMD, areaId: null })).resolves.toBe('replied');
    expect(gateway.replies).toHaveLength(1);
  });
});

describe('ReplyWithAssistant — handoff SIEMPRE deja rastro en Chatwoot (D11)', () => {
  it('fuera de alcance: label + nota privada, sin hablarle al cliente', async () => {
    const { useCase, gateway } = await harness({ classify: { kind: 'out_of_scope' } });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');

    expect(gateway.replies).toEqual([]);
    expect(gateway.allLabels).toContain('necesita-humano');
    expect(gateway.notes).toHaveLength(1);
  });

  it('el modelo se declara incapaz (centinela NO_PUEDO_RESPONDER)', async () => {
    const { useCase, gateway } = await harness({ generate: { kind: 'cannot_answer' } });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');
    expect(gateway.replies).toEqual([]);
    expect(gateway.allLabels).toContain('necesita-humano');
  });

  it('ACT-1: la acción no está habilitada en el perfil', async () => {
    const { useCase, gateway } = await harness({ enabledActions: ['private_note'] });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');
    expect(gateway.replies).toEqual([]);
  });

  it('SEC-3: fuera de la ventana de 24 h no se le escribe al cliente, pero SÍ se avisa', async () => {
    const { useCase, gateway } = await harness();

    await expect(useCase.execute({ ...CMD, canReply: false })).resolves.toBe('handoff');

    expect(gateway.replies).toEqual([]);
    // Lo importante: el humano SE ENTERA de que llegó algo sin responder.
    expect(gateway.allLabels).toContain('necesita-humano');
    expect(gateway.notes).toHaveLength(1);
  });

  it('clasificador caído ⇒ error, y tampoco se improvisa una respuesta', async () => {
    const { useCase, gateway } = await harness({ classify: { kind: 'unavailable' } });

    await expect(useCase.execute(CMD)).resolves.toBe('error');
    expect(gateway.replies).toEqual([]);
    expect(gateway.allLabels).toContain('necesita-humano');
  });

  it('el modelo devuelve una key inexistente ⇒ default deny', async () => {
    const { useCase, gateway } = await harness({
      classify: { kind: 'intent', key: 'intent-que-no-existe' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');
    expect(gateway.replies).toEqual([]);
  });
});

// ── SEC-4: la red que convierte una alucinación en un handoff ───────────────
describe('ReplyWithAssistant — SEC-4 bloquea el envío', () => {
  it('el modelo inventa un monto ⇒ la respuesta NO se envía', async () => {
    const { useCase, gateway } = await harness({
      facts: { saldo: 45000 },
      generate: { kind: 'text', text: 'Tu saldo es $54000.' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('rejected_numbers');

    expect(gateway.replies).toEqual([]);
    expect(gateway.allLabels).toContain('necesita-humano');
  });

  it('el bot PUEDE citar un número que escribió el cliente', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'ya pagué 78000 la semana pasada',
      generate: { kind: 'text', text: 'Veo que mencionás 78000, lo verifico.' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');
    expect(gateway.replies).toHaveLength(1);
  });

  it('OBS-1: el rechazo queda auditado como outcome propio', async () => {
    const { useCase, runs } = await harness({
      generate: { kind: 'text', text: 'son $99999' },
    });

    await useCase.execute(CMD);

    const { items } = await runs.list({ outcome: 'rejected_numbers' });
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe('number_not_in_facts');
  });
});

// ── CONV-2/CONV-3: modo CONVERSAR ──────────────────────────────────────────
describe('ReplyWithAssistant — modo CONVERSAR', () => {
  it('CONV-2: un saludo se responde, NO dispara handoff', async () => {
    const { useCase, gateway } = await harness({
      classify: { kind: 'chat' },
      customerText: 'hola',
      generate: { kind: 'text', text: '¡Hola! ¿En qué te ayudo?' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');
    expect(gateway.replies).toEqual(['¡Hola! ¿En qué te ayudo?']);
  });

  it('CONV-3: en charla NINGUNA cifra es válida — sin hechos, whitelist vacío', async () => {
    const { useCase, gateway } = await harness({
      classify: { kind: 'chat' },
      customerText: 'hola',
      generate: { kind: 'text', text: 'Hola, tu saldo es $45000.' },
    });

    // 45000 existe en los hechos... pero en modo charla los hechos NO se inyectan.
    await expect(useCase.execute(CMD)).resolves.toBe('rejected_numbers');
    expect(gateway.replies).toEqual([]);
  });

  it('CONV-2: la charla no resuelve ninguna fuente de datos', async () => {
    const { useCase, runs } = await harness({
      classify: { kind: 'chat' },
      generate: { kind: 'text', text: 'Hola, contame.' },
    });

    await useCase.execute(CMD);

    const { items } = await runs.list({});
    expect(items[0].dataSources).toEqual([]);
    expect(items[0].intentName).toBeNull();
  });
});

// ── RUN-1: el motor nunca lanza ────────────────────────────────────────────
// ── Fixes del review adversarial ───────────────────────────────────────────
describe('ReplyWithAssistant — anti-ráfaga (review adversarial)', () => {
  it('NO responde dos veces seguidas a la misma conversación', async () => {
    // El cliente manda "hola" / "quería consultar" / "sobre mi factura" en 5 segundos.
    // Chatwoot dispara 3 webhooks. Sin este guard, el cliente recibe 3 respuestas pisándose.
    const { useCase, gateway } = await harness();

    await expect(useCase.execute(CMD)).resolves.toBe('replied');
    await expect(useCase.execute(CMD)).resolves.toBe('noop');
    await expect(useCase.execute(CMD)).resolves.toBe('noop');

    expect(gateway.replies).toHaveLength(1);
  });

  it('el turno salteado queda auditado con su motivo', async () => {
    const { useCase, runs } = await harness();
    await useCase.execute(CMD);
    await useCase.execute(CMD);

    const { items } = await runs.list({ outcome: 'noop' });
    expect(items[0].reason).toBe('debounced_recent_reply');
  });

  it('un HANDOFF previo NO bloquea la respuesta al mensaje siguiente', async () => {
    // Sólo los `replied` frenan: si el bot derivó, el próximo mensaje debe poder atenderse.
    const { useCase, gateway } = await harness({ classify: { kind: 'out_of_scope' } });
    await useCase.execute(CMD);

    const second = await harness();
    await expect(second.useCase.execute(CMD)).resolves.toBe('replied');
    expect(second.gateway.replies).toHaveLength(1);
    expect(gateway.replies).toHaveLength(0);
  });

  it('conversaciones DISTINTAS no se bloquean entre sí', async () => {
    const { useCase, gateway } = await harness();

    await useCase.execute(CMD);
    await useCase.execute({ ...CMD, conversationId: 'conv-2' });

    expect(gateway.replies).toHaveLength(2);
  });
});

describe('ReplyWithAssistant — un fallo interno AVISA (review adversarial)', () => {
  it('una excepción deja label + nota privada, no silencio', async () => {
    // Antes: se registraba el error y nada más. El cliente preguntaba, el bot se rompía por
    // dentro, y la conversación quedaba huérfana con apariencia de atendida.
    const { useCase, gateway, profiles } = await harness();
    jest.spyOn(profiles, 'findByAreaId').mockRejectedValueOnce(new Error('la base tosió'));

    await expect(useCase.execute(CMD)).resolves.toBe('error');

    expect(gateway.allLabels).toContain('necesita-humano');
    expect(gateway.notes).toHaveLength(1);
    expect(gateway.replies).toEqual([]);
  });

  it('si Chatwoot TAMBIÉN está caído, el motor igual devuelve error sin lanzar', async () => {
    const { useCase, gateway, profiles } = await harness();
    jest.spyOn(profiles, 'findByAreaId').mockRejectedValueOnce(new Error('la base tosió'));
    jest.spyOn(gateway, 'applyLabels').mockRejectedValueOnce(new Error('Chatwoot caído'));
    jest.spyOn(gateway, 'privateNote').mockRejectedValueOnce(new Error('Chatwoot caído'));

    await expect(useCase.execute(CMD)).resolves.toBe('error');
  });
});

describe('ReplyWithAssistant — RUN-1', () => {
  it('un repo que revienta NO propaga: degrada a error auditado', async () => {
    const { useCase, runs, profiles } = await harness();
    jest.spyOn(profiles, 'findByAreaId').mockRejectedValueOnce(new Error('la base tosió'));

    await expect(useCase.execute(CMD)).resolves.toBe('error');

    const { items } = await runs.list({ outcome: 'error' });
    expect(items[0].reason).toBe('engine_error');
  });

  it('un fallo del rastro en Chatwoot NO invalida la respuesta ya enviada', async () => {
    const { useCase, gateway } = await harness();
    jest.spyOn(gateway, 'applyLabels').mockRejectedValueOnce(new Error('Chatwoot caído'));

    await expect(useCase.execute(CMD)).resolves.toBe('replied');
    expect(gateway.replies).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ai-assistant-cobranzas — Lote E (5.1-5.4) y Lote G2 (5.6-5.9)
// ═══════════════════════════════════════════════════════════════════════════

describe('ReplyWithAssistant — pre-chequeo determinístico (RTR-4 / D5)', () => {
  it('5.1: "ya pagué y no tengo internet" fuerza la intent de STOP SIN llamar al clasificador', async () => {
    // El peor modo de falla del change: cobrarle a alguien que no tiene servicio. No puede
    // depender de que el clasificador acierte.
    const { useCase, gateway, runs } = await harness({
      customerText: 'ya pagué y no tengo internet',
      stopTriggerPatterns: ['no tengo (internet|servicio)'],
      enabledActions: ['whatsapp_reply', 'private_note', 'handoff'],
      classify: { kind: 'intent', key: 'jamás-debería-usarse' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');

    expect(gateway.replies).toEqual([]);
    const { items } = await runs.list({});
    expect(items[0].reason).toBe('trigger_pattern');
    expect(items[0].intentName).toBe('reclamo_servicio');
  });

  it('5.1: sin pattern que matchee, decide el clasificador como siempre', async () => {
    const { useCase, gateway } = await harness({
      customerText: '¿cuánto debo?',
      stopTriggerPatterns: ['no tengo (internet|servicio)'],
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');
    expect(gateway.replies).toHaveLength(1);
  });

  it('RTR-4: una regex inválida se ignora y no rompe el motor', async () => {
    const { useCase } = await harness({
      customerText: 'hola',
      stopTriggerPatterns: ['([sin cerrar'],
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');
  });
});

describe('ReplyWithAssistant — acción `handoff` (ACT-3 / D2)', () => {
  it('5.2: aplica intent.labels ∪ necesita-humano, deja nota STOP y NO le habla al cliente', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'no tengo internet',
      stopTriggerPatterns: ['no tengo internet'],
      stopLabels: ['soporte'],
      enabledActions: ['whatsapp_reply', 'private_note', 'handoff'],
    });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');

    expect(gateway.replies).toEqual([]);
    expect(gateway.allLabels).toEqual(expect.arrayContaining(['soporte', 'necesita-humano']));
    expect(gateway.notes.join('\n')).toMatch(/STOP:/);
  });

  it('5.2: un label inválido NO bloquea `necesita-humano` ni la nota', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'no tengo internet',
      stopTriggerPatterns: ['no tengo internet'],
      stopLabels: ['label que Chatwoot rechaza'],
      enabledActions: ['handoff'],
    });
    // El applyLabels revienta: el rastro de handoff igual tiene que quedar.
    jest.spyOn(gateway, 'applyLabels').mockRejectedValueOnce(new Error('Chatwoot rechazó el label'));

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');
    expect(gateway.notes.join('\n')).toMatch(/STOP:/);
  });
});

describe('ReplyWithAssistant — guarda de agente activo (SEC-6 / D4)', () => {
  const conAgenteHumano: AssistantThreadMessage[] = [
    { role: 'customer', text: '¿cuánto debo?', generatedByAssistant: false, attachmentFilenames: [] },
    { role: 'agent', text: 'Hola, soy Vanesa, lo veo.', generatedByAssistant: false, attachmentFilenames: [] },
  ];

  it('5.3: un turno de agente HUMANO posterior al último customer ⇒ noop', async () => {
    const { useCase, gateway, runs } = await harness({ thread: conAgenteHumano });

    await expect(useCase.execute(CMD)).resolves.toBe('noop');

    expect(gateway.replies).toEqual([]);
    const { items } = await runs.list({ outcome: 'noop' });
    expect(items[0].reason).toBe('agent_active');
  });

  it('5.3: el turno del BOT no cuenta como agente activo', async () => {
    const { useCase, gateway } = await harness({
      thread: [
        { role: 'agent', text: 'Tu saldo es $45000.', generatedByAssistant: true, attachmentFilenames: [] },
        { role: 'customer', text: '¿y las facturas?', generatedByAssistant: false, attachmentFilenames: [] },
      ],
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');
    expect(gateway.replies).toHaveLength(1);
  });

  it('5.3: `assigneeName` no vacío en el payload ⇒ noop, aunque el hilo no muestre nada', async () => {
    const { useCase, gateway, runs } = await harness();

    await expect(useCase.execute({ ...CMD, assigneeName: 'Vanesa' })).resolves.toBe('noop');

    expect(gateway.replies).toEqual([]);
    const { items } = await runs.list({ outcome: 'noop' });
    expect(items[0].reason).toBe('agent_active');
  });
});

describe('ReplyWithAssistant — bloque de facturas y split (D3 / REN-1 / REN-2)', () => {
  const DOS_FACTURAS = {
    'cliente.facturas': {
      disponible: true,
      cantidad: 2,
      facturas: [
        {
          tipo: 'FC A',
          numero: '0001-1',
          vencimiento: '2026-09-10',
          saldo: 1000,
          pdfUrl: null,
          couponPdfUrl: null,
          paymentUrl: 'https://mp.example/pay/1',
        },
        {
          tipo: 'FC A',
          numero: '0001-2',
          vencimiento: '2026-10-10',
          saldo: 2000,
          pdfUrl: null,
          couponPdfUrl: null,
          paymentUrl: 'https://mp.example/pay/2',
        },
      ],
      linkPagoTotal: 'https://mp.example/total',
    },
  };

  function facturasLargas(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      tipo: 'FC A',
      numero: `0001-${i + 1}`,
      vencimiento: '2026-09-10',
      saldo: 1000 + i,
      pdfUrl: null,
      couponPdfUrl: null,
      paymentUrl: `https://mp.example/pagar/factura/numero/${i + 1}/con-un-token-largo-para-empujar`,
    }));
  }

  it('5.4: el bloque se ANEXA después de SEC-4 — el texto del modelo no lleva montos ni links', async () => {
    const { useCase, gateway } = await harness({
      factsByKey: DOS_FACTURAS,
      generate: { kind: 'text', text: 'Te paso el detalle de tus facturas.' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');

    const enviado = gateway.replies.join('\n');
    expect(enviado).toContain('https://mp.example/pay/1');
    expect(enviado).toContain('https://mp.example/pay/2');
    expect(enviado).toContain('https://mp.example/total');
    expect(enviado).toContain('Te paso el detalle de tus facturas.');
  });

  it('5.4: el bloque NO pasa por el verificador de números (es determinístico)', async () => {
    // Los importes y los dígitos de las URLs no están en el texto del modelo: si el bloque
    // pasara por SEC-4, esta corrida terminaría en `rejected_numbers`.
    const { useCase } = await harness({
      factsByKey: DOS_FACTURAS,
      generate: { kind: 'text', text: 'Te paso el detalle.' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');
  });

  it('REN-2: el mensaje largo se parte en chunks de <=1400 numerados', async () => {
    const { useCase, gateway } = await harness({
      factsByKey: {
        'cliente.facturas': {
          disponible: true,
          cantidad: 12,
          facturas: facturasLargas(12),
          linkPagoTotal: 'https://mp.example/total',
        },
      },
      generate: { kind: 'text', text: 'Te paso el detalle.' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');

    expect(gateway.replies.length).toBeGreaterThan(1);
    for (const chunk of gateway.replies) expect(chunk.length).toBeLessThanOrEqual(1400);
    expect(gateway.replies[0]).toMatch(/^\(1\/\d+\)/);
  });

  it('5.4: si falla un chunk del medio => `partial_send` + nota privada, NUNCA silencio', async () => {
    const { useCase, gateway, runs } = await harness({
      factsByKey: {
        'cliente.facturas': {
          disponible: true,
          cantidad: 12,
          facturas: facturasLargas(12),
          linkPagoTotal: 'https://mp.example/total',
        },
      },
      generate: { kind: 'text', text: 'Te paso el detalle.' },
    });
    const real = gateway.reply.bind(gateway);
    let n = 0;
    jest.spyOn(gateway, 'reply').mockImplementation(async (c: string, text: string) => {
      n += 1;
      if (n === 2) throw new Error('WhatsApp cortó');
      await real(c, text);
    });

    await expect(useCase.execute(CMD)).resolves.toBe('error');

    const { items } = await runs.list({ outcome: 'error' });
    expect(items[0].reason).toBe('partial_send');
    expect(gateway.notes.join('\n')).toMatch(/envié \d+ de \d+ mensajes/);
  });
});

describe('ReplyWithAssistant — comprobante: pre-chequeo, selector y signo (D11)', () => {
  const RECIBO_CON_MATCH = {
    disponible: true,
    recibos: [
      { hora: '10:15', recaudador: 'mercadopago', importe: 41410.56, referencias: ['MercadoPago: 177332834792'] },
    ],
    matchOperacion: { operacion: '177332834792', encontrado: true, importe: 41410.56 },
    posibleDoblePago: false,
  };

  const ROLES = [
    { roleKey: 'comprobante_mp', dataSourceKeys: ['cliente.recibos_hoy', 'cliente.saldo', 'cliente.facturas'] },
    {
      roleKey: 'pago_parcial_con_promesa',
      dataSourceKeys: ['cliente.recibos_hoy', 'cliente.saldo', 'cliente.facturas'],
      labels: ['administracion'],
      unassign: true,
    },
    {
      roleKey: 'comprobante_transferencia',
      actionKey: 'handoff',
      labels: ['administracion'],
      unassign: true,
    },
    {
      roleKey: 'promesa_pago',
      actionKey: 'handoff',
      labels: ['administracion'],
      unassign: true,
      triggerPatterns: ['a fin de mes', 'cuando cobre'],
    },
  ];

  const SIN_FACTURAS = { disponible: false, motivo: 'facturas_no_disponibles', guia: 'no afirmes nada' };

  it('5.6: un adjunto `comprobante_<op>.pdf` le gana al pattern de `promesa_pago`', async () => {
    const { useCase, runs } = await harness({
      customerText: 'te paso el comprobante, el resto a fin de mes',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ['whatsapp_reply', 'private_note', 'handoff'],
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': RECIBO_CON_MATCH,
        'cliente.saldo': { disponible: true, saldo: 31178, moneda: 'ARS', tieneDeuda: true },
        'cliente.facturas': SIN_FACTURAS,
      },
      generate: { kind: 'text', text: 'Gracias, lo verifico.' },
    });

    await useCase.execute(CMD);

    const { items } = await runs.list({});
    // Con deuda restante Y promesa en el texto => la fila R4, no `promesa_pago` a secas.
    expect(items[0].intentName).toBe('pago_parcial_con_promesa');
  });

  it('5.6: sin adjunto, la promesa SÍ gana en el pre-chequeo', async () => {
    const { useCase, runs } = await harness({
      customerText: 'te pago a fin de mes',
      enabledActions: ['whatsapp_reply', 'private_note', 'handoff'],
      roleIntents: ROLES,
    });

    await useCase.execute(CMD);

    const { items } = await runs.list({});
    expect(items[0].intentName).toBe('promesa_pago');
  });

  it('5.7: sin match de la operación => redirige a `comprobante_transferencia` (R1)', async () => {
    const { useCase, runs, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ['whatsapp_reply', 'private_note', 'handoff'],
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': {
          disponible: true,
          recibos: [],
          matchOperacion: { operacion: '177332834792', encontrado: false },
          posibleDoblePago: false,
        },
        'cliente.saldo': { disponible: true, saldo: 31178, moneda: 'ARS', tieneDeuda: true },
        'cliente.facturas': SIN_FACTURAS,
      },
    });

    await useCase.execute(CMD);

    const { items } = await runs.list({});
    expect(items[0].intentName).toBe('comprobante_transferencia');
    expect(gateway.allLabels).toContain('administracion');
  });

  it('5.7: GR caído => también `comprobante_transferencia`, nunca "no vemos tu pago"', async () => {
    const { useCase, runs } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ['whatsapp_reply', 'private_note', 'handoff'],
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': { disponible: false, motivo: 'recibos_no_disponibles', guia: 'no afirmes' },
        'cliente.saldo': { disponible: true, saldo: 31178, moneda: 'ARS', tieneDeuda: true },
        'cliente.facturas': SIN_FACTURAS,
      },
    });

    await useCase.execute(CMD);

    const { items } = await runs.list({});
    expect(items[0].intentName).toBe('comprobante_transferencia');
  });

  it('5.7: el `roleKey` de destino no existe => necesita-humano + nota, nunca comportamiento inventado', async () => {
    const { useCase, gateway, runs } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ['whatsapp_reply', 'private_note', 'handoff'],
      // Sólo existe `comprobante_mp`: el selector va a pedir `comprobante_transferencia`.
      roleIntents: [{ roleKey: 'comprobante_mp', dataSourceKeys: ['cliente.recibos_hoy', 'cliente.saldo'] }],
      factsByKey: {
        'cliente.recibos_hoy': { disponible: false, motivo: 'recibos_no_disponibles', guia: 'no afirmes' },
        'cliente.saldo': { disponible: true, saldo: 31178, moneda: 'ARS', tieneDeuda: true },
      },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');

    expect(gateway.allLabels).toContain('necesita-humano');
    expect(gateway.notes.join('\n')).toMatch(/comprobante_transferencia/);
    const { items } = await runs.list({ outcome: 'handoff' });
    expect(items[0].reason).toBe('missing_role_key');
  });

  it('5.9 (R2): pago verificado con deuda restante => reconoce el pago y NO dice "al día"', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ['whatsapp_reply', 'private_note', 'handoff'],
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': RECIBO_CON_MATCH,
        'cliente.saldo': { disponible: true, saldo: 72589.41, moneda: 'ARS', tieneDeuda: true },
        'cliente.facturas': SIN_FACTURAS,
      },
      generate: { kind: 'text', text: 'Gracias por el comprobante.' },
    });

    await useCase.execute(CMD);

    const dicho = [...gateway.replies, ...gateway.notes].join('\n').toLowerCase();
    expect(dicho).toMatch(/recibimos tu pago/);
    expect(dicho).not.toMatch(/al d[ií]a/);
  });

  it('5.9 (R5): doble pago => el mensaje lo menciona y se aplica `administracion`', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ['whatsapp_reply', 'private_note', 'handoff'],
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': { ...RECIBO_CON_MATCH, posibleDoblePago: true },
        'cliente.saldo': { disponible: true, saldo: 0, moneda: null, tieneDeuda: false },
        'cliente.facturas': SIN_FACTURAS,
      },
      generate: { kind: 'text', text: 'Gracias por el comprobante.' },
    });

    await useCase.execute(CMD);

    const dicho = [...gateway.replies, ...gateway.notes].join('\n').toLowerCase();
    expect(dicho).toMatch(/dos pagos/);
    expect(gateway.allLabels).toContain('administracion');
  });

  it('RSP-1: `cliente.saldo` no disponible => no se afirma ni deuda ni al día', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ['whatsapp_reply', 'private_note', 'handoff'],
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': RECIBO_CON_MATCH,
        'cliente.saldo': { disponible: false, motivo: 'saldo_desactualizado', guia: 'no menciones importes' },
        'cliente.facturas': SIN_FACTURAS,
      },
      generate: { kind: 'text', text: 'Gracias, lo verifico con un asesor.' },
    });

    await useCase.execute(CMD);

    const dicho = [...gateway.replies, ...gateway.notes].join('\n').toLowerCase();
    expect(dicho).not.toMatch(/al d[ií]a/);
    expect(dicho).not.toMatch(/te quedan/);
  });
});

describe('ReplyWithAssistant — labels y unassign en CUALQUIER acción (ACT-3 / ACT-4 / D10)', () => {
  it('5.8: una intent que RESPONDE también etiqueta y desasigna', async () => {
    const { useCase, gateway } = await harness({
      intentLabels: ['administracion'],
      intentUnassign: true,
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');

    expect(gateway.replies).toHaveLength(1);
    expect(gateway.allLabels).toEqual(expect.arrayContaining(['bot-respondió', 'administracion']));
    expect(gateway.unassignCount).toBe(1);
  });

  it('5.8: con `unassign:false` se etiqueta pero NO se desasigna', async () => {
    const { useCase, gateway } = await harness({ intentLabels: ['administracion'], intentUnassign: false });

    await useCase.execute(CMD);

    expect(gateway.allLabels).toContain('administracion');
    expect(gateway.unassignCount).toBe(0);
  });

  it('5.8: un fallo de `unassign` NO cambia el outcome de una respuesta ya enviada', async () => {
    const { useCase, gateway } = await harness({ intentUnassign: true });
    jest.spyOn(gateway, 'unassign').mockRejectedValueOnce(new Error('Chatwoot caído'));

    await expect(useCase.execute(CMD)).resolves.toBe('replied');
    expect(gateway.replies).toHaveLength(1);
  });

  it('5.8: el orden es acción -> labels -> unassign (una huérfana sin explicación es peor)', async () => {
    const orden: string[] = [];
    const { useCase, gateway } = await harness({ intentLabels: ['administracion'], intentUnassign: true });
    jest.spyOn(gateway, 'reply').mockImplementation(async () => {
      orden.push('reply');
    });
    jest.spyOn(gateway, 'applyLabels').mockImplementation(async () => {
      orden.push('labels');
    });
    jest.spyOn(gateway, 'unassign').mockImplementation(async () => {
      orden.push('unassign');
    });

    await useCase.execute(CMD);

    expect(orden[0]).toBe('reply');
    expect(orden[orden.length - 1]).toBe('unassign');
  });
});

/**
 * ═══ FIX WAVE (verify adversarial 2026-09-05) ═══════════════════════════════
 *
 * Cada test de acá reproduce un hallazgo CONCRETO de la verificación. Ninguno es una
 * variación de un test existente: los que había daban verde con el bug adentro (fixtures
 * degenerados o ramas inalcanzables).
 */
describe('ReplyWithAssistant — fix wave: comprobante vs. STOP, signo, frases y rastro', () => {
  const RECIBO_CON_MATCH = {
    disponible: true,
    recibos: [
      {
        fecha: '04-09-2026',
        hora: '10:15',
        recaudador: 'mercadopago',
        importe: 41410.56,
        referencias: ['MercadoPago: 177332834792'],
      },
    ],
    matchOperacion: { operacion: '177332834792', encontrado: true, importe: 41410.56 },
    posibleDoblePago: false,
  };

  const ROLES = [
    // `whatsapp_reply` explícito: estos tests miran lo que RECIBE EL CLIENTE. (En el seed las
    // intents nacen en `private_note` por DFT-1 — modo borrador — y eso se prueba aparte.)
    {
      roleKey: 'comprobante_mp',
      actionKey: 'whatsapp_reply',
      dataSourceKeys: ['cliente.recibos_hoy', 'cliente.saldo', 'cliente.facturas'],
    },
    {
      roleKey: 'pago_parcial_con_promesa',
      actionKey: 'whatsapp_reply',
      dataSourceKeys: ['cliente.recibos_hoy', 'cliente.saldo', 'cliente.facturas'],
      labels: ['administracion'],
      unassign: true,
    },
    {
      roleKey: 'comprobante_transferencia',
      actionKey: 'handoff',
      labels: ['administracion'],
      unassign: true,
      dataSourceKeys: ['cliente.recibos_hoy', 'cliente.saldo'],
    },
    {
      roleKey: 'promesa_pago',
      actionKey: 'handoff',
      labels: ['administracion'],
      unassign: true,
      triggerPatterns: ['a fin de mes', 'cuando cobre'],
    },
  ];

  const SIN_FACTURAS = { disponible: false, motivo: 'facturas_no_disponibles', guia: 'no afirmes nada' };
  const ACCIONES = ['whatsapp_reply', 'private_note', 'handoff'];

  // ── C1 ────────────────────────────────────────────────────────────────────
  it('C1: el adjunto de comprobante NO desactiva un trigger de STOP (sólo le gana a `promesa_pago`)', async () => {
    const { useCase, gateway, runs } = await harness({
      customerText: 'ya pagué, te paso el comprobante, pero hace 3 días que no tengo internet',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      stopTriggerPatterns: ['no tengo internet'],
      stopLabels: ['soporte'],
      enabledActions: ACCIONES,
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': RECIBO_CON_MATCH,
        'cliente.saldo': { disponible: true, saldo: 31178, moneda: 'ARS', tieneDeuda: true },
        'cliente.facturas': SIN_FACTURAS,
      },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');

    // Cobrarle a alguien que hace 3 días no tiene servicio es exactamente lo que D5 impide.
    expect(gateway.replies).toEqual([]);
    expect(gateway.allLabels).toEqual(expect.arrayContaining(['soporte', 'necesita-humano']));
    const { items } = await runs.list({});
    expect(items[0].intentName).toBe('reclamo_servicio');
  });

  it('C1: el adjunto SIGUE ganándole a `promesa_pago` (la excepción D11 no se pierde)', async () => {
    const { useCase, runs } = await harness({
      customerText: 'te paso el comprobante, el resto a fin de mes',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': RECIBO_CON_MATCH,
        'cliente.saldo': { disponible: true, saldo: 31178, moneda: 'ARS', tieneDeuda: true },
        'cliente.facturas': SIN_FACTURAS,
      },
      generate: { kind: 'text', text: 'Gracias, lo verifico.' },
    });

    await useCase.execute(CMD);

    const { items } = await runs.list({});
    expect(items[0].intentName).toBe('pago_parcial_con_promesa');
  });

  // ── C3 ────────────────────────────────────────────────────────────────────
  it('C3: con `cliente.facturas` disponible informa "en N facturas"', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': RECIBO_CON_MATCH,
        'cliente.saldo': { disponible: true, saldo: 72589.41, moneda: 'ARS', tieneDeuda: true },
        'cliente.facturas': {
          disponible: true,
          cantidad: 3,
          facturas: [
            { tipo: 'FC A', numero: '0001-1', vencimiento: '2026-09-10', saldo: 1000, pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
            { tipo: 'FC A', numero: '0001-2', vencimiento: '2026-10-10', saldo: 2000, pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
            { tipo: 'FC A', numero: '0001-3', vencimiento: '2026-11-10', saldo: 3000, pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
          ],
          linkPagoTotal: null,
        },
      },
      generate: { kind: 'text', text: 'Gracias por el comprobante.' },
    });

    await useCase.execute(CMD);

    expect(gateway.replies.join('\n')).toContain('en 3 facturas');
  });

  it('C3: sin conteo de facturas, JAMÁS dice "en 0 facturas"', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': RECIBO_CON_MATCH,
        'cliente.saldo': { disponible: true, saldo: 72589.41, moneda: 'ARS', tieneDeuda: true },
        'cliente.facturas': SIN_FACTURAS,
      },
      generate: { kind: 'text', text: 'Gracias por el comprobante.' },
    });

    await useCase.execute(CMD);

    const dicho = gateway.replies.join('\n');
    expect(dicho).toContain('72.589,41');
    expect(dicho).not.toMatch(/0 factura/);
    expect(dicho).not.toMatch(/en \d+ facturas?/);
  });

  // ── C4 ────────────────────────────────────────────────────────────────────
  it('C4: saldo A FAVOR ⇒ el mensaje lo menciona con su importe y nunca dice que debe', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': RECIBO_CON_MATCH,
        // La forma EXACTA que emite `ClienteSaldoResolver` para `balanceDue = -77997.19`
        // (FW2-1 intacto: `saldo` sigue en 0; el crédito viaja en el hecho INTERNO `_aFavor`,
        // que nunca llega ni al prompt ni al whitelist de SEC-4).
        'cliente.saldo': { disponible: true, saldo: 0, _aFavor: 77997.19, moneda: null, tieneDeuda: false },
        'cliente.facturas': SIN_FACTURAS,
      },
      generate: { kind: 'text', text: 'Gracias por el comprobante.' },
    });

    await useCase.execute(CMD);

    const dicho = gateway.replies.join('\n');
    expect(dicho).toContain('77.997,19');
    expect(dicho.toLowerCase()).toMatch(/a favor/);
    expect(dicho.toLowerCase()).not.toMatch(/deb[eé]/);
  });

  // ── C5 ────────────────────────────────────────────────────────────────────
  it('C5: el modelo dice "estás al día" con deuda > 0 ⇒ su texto se descarta, queda el bloque determinístico', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': RECIBO_CON_MATCH,
        'cliente.saldo': { disponible: true, saldo: 72589.41, moneda: 'ARS', tieneDeuda: true },
        'cliente.facturas': SIN_FACTURAS,
      },
      // Sin cifras: SEC-4 lo deja pasar. El único freno posible es el guard de FRASE.
      generate: { kind: 'text', text: 'Estás al día, no tenés facturas pendientes.' },
    });

    await useCase.execute(CMD);

    const dicho = gateway.replies.join('\n');
    expect(dicho).not.toMatch(/al d[ií]a/i);
    expect(dicho).toContain('Recibimos tu pago');
  });

  it('C5: el modelo dice "te queda pendiente" con saldo ≤ 0 ⇒ también se descarta', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': RECIBO_CON_MATCH,
        'cliente.saldo': { disponible: true, saldo: 0, moneda: null, tieneDeuda: false },
        'cliente.facturas': SIN_FACTURAS,
      },
      generate: { kind: 'text', text: 'Todavía te queda un saldo pendiente.' },
    });

    await useCase.execute(CMD);

    const dicho = gateway.replies.join('\n');
    expect(dicho).not.toMatch(/pendiente/i);
    expect(dicho.toLowerCase()).toMatch(/al día/);
  });

  it('C5: sin bloque determinístico que rescate el turno ⇒ handoff, no se envía nada', async () => {
    const { useCase, gateway, runs } = await harness({
      facts: { disponible: true, saldo: 45000, moneda: 'ARS', tieneDeuda: true },
      generate: { kind: 'text', text: 'Estás al día.' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');

    expect(gateway.replies).toEqual([]);
    expect(gateway.allLabels).toContain('necesita-humano');
    const { items } = await runs.list({ outcome: 'handoff' });
    expect(items[0].reason).toBe('contradicts_balance');
  });

  // ── W3 ────────────────────────────────────────────────────────────────────
  it('W3: `rejected_numbers` también aplica los labels y el unassign de la intent (ACT-3)', async () => {
    const { useCase, gateway } = await harness({
      intentLabels: ['administracion'],
      intentUnassign: true,
      facts: { disponible: true, saldo: 45000, moneda: 'ARS', tieneDeuda: true },
      generate: { kind: 'text', text: 'Tu deuda es de $99999999.' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('rejected_numbers');

    expect(gateway.allLabels).toEqual(expect.arrayContaining(['necesita-humano', 'administracion']));
    expect(gateway.unassignCount).toBe(1);
  });

  it('W3: fuera de la ventana de 24 h el handoff también arrastra labels y unassign', async () => {
    const { useCase, gateway } = await harness({ intentLabels: ['administracion'], intentUnassign: true });

    await expect(useCase.execute({ ...CMD, canReply: false })).resolves.toBe('handoff');

    expect(gateway.allLabels).toEqual(expect.arrayContaining(['necesita-humano', 'administracion']));
    expect(gateway.unassignCount).toBe(1);
  });

  // ── W7 ────────────────────────────────────────────────────────────────────
  it('W7: `partial_send` NO puede quedar etiquetado como `bot-respondió`', async () => {
    const { useCase, gateway } = await harness({
      factsByKey: {
        'cliente.facturas': {
          disponible: true,
          cantidad: 12,
          facturas: Array.from({ length: 12 }, (_, i) => ({
            tipo: 'FC A',
            numero: `0001-${i + 1}`,
            vencimiento: '2026-09-10',
            saldo: 1000 + i,
            pdfUrl: null,
            couponPdfUrl: null,
            paymentUrl: `https://mp.example/pagar/factura/numero/${i + 1}/con-un-token-largo-para-empujar`,
          })),
          linkPagoTotal: 'https://mp.example/total',
        },
      },
      generate: { kind: 'text', text: 'Te paso el detalle.' },
    });
    const real = gateway.reply.bind(gateway);
    let n = 0;
    jest.spyOn(gateway, 'reply').mockImplementation(async (c: string, text: string) => {
      n += 1;
      if (n === 2) throw new Error('WhatsApp cortó');
      await real(c, text);
    });

    await expect(useCase.execute(CMD)).resolves.toBe('error');

    expect(gateway.allLabels).not.toContain('bot-respondió');
    expect(gateway.allLabels).toContain('necesita-humano');
  });

  // ── W9 ────────────────────────────────────────────────────────────────────
  it('W9: cuando hay alias de pago, el bloque incluye la aclaración de titularidad (REN-1)', async () => {
    const { useCase, gateway } = await harness({
      factsByKey: {
        'cliente.facturas': {
          disponible: true,
          cantidad: 1,
          facturas: [
            { tipo: 'FC A', numero: '0001-1', vencimiento: '2026-09-10', saldo: 1000, pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
          ],
          linkPagoTotal: null,
          aliasPago: 'ipnext.cobros',
        },
      },
      generate: { kind: 'text', text: 'Te paso el detalle.' },
    });

    await useCase.execute(CMD);

    const dicho = gateway.replies.join('\n');
    expect(dicho).toContain('ipnext.cobros');
    expect(dicho).toContain('titular IPNEXT S.A., CUIT 30-70849985-0');
    expect(dicho).toContain('Si ves otro dato, no transfieras');
  });

  // ── W10 ───────────────────────────────────────────────────────────────────
  it('W10: `comprobante_transferencia` RESPONDE el acuse determinístico, además de derivar', async () => {
    const { useCase, gateway, runs } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': {
          disponible: true,
          recibos: [],
          matchOperacion: { operacion: '177332834792', encontrado: false },
          posibleDoblePago: false,
        },
        'cliente.saldo': { disponible: true, saldo: 31178, moneda: 'ARS', tieneDeuda: true },
      },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');

    const dicho = gateway.replies.join('\n');
    expect(dicho).toContain('Recibimos tu comprobante');
    expect(dicho).toContain('operación 177332834792');
    expect(dicho).toContain('31.178,00');
    // N1 — el acuse NO afirma el medio de pago (a esta rama se llega también con un pago por
    // link que GR todavía no ingestó) y califica el saldo como PRE-imputación.
    expect(dicho).toContain('sin contar este pago');
    expect(dicho.toLowerCase()).not.toContain('transferencia');
    expect(dicho).toMatch(/administraci[oó]n lo revisa e imputa a mano/i);
    expect(dicho).toContain('IPNEXT Cobranzas');
    // D10 — el rastro de siempre: label de administración, desasignar y nota para el humano.
    expect(gateway.allLabels).toEqual(expect.arrayContaining(['administracion', 'necesita-humano']));
    expect(gateway.unassignCount).toBe(1);
    expect(gateway.notes.join('\n')).toMatch(/STOP:/);
    const { items } = await runs.list({});
    expect(items[0].intentName).toBe('comprobante_transferencia');
  });

  it('W10: sin ventana de 24 h el acuse NO se envía, pero la derivación sigue (SEC-3)', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES,
      factsByKey: {
        'cliente.recibos_hoy': {
          disponible: true,
          recibos: [],
          matchOperacion: { operacion: '177332834792', encontrado: false },
          posibleDoblePago: false,
        },
        'cliente.saldo': { disponible: true, saldo: 31178, moneda: 'ARS', tieneDeuda: true },
      },
    });

    await expect(useCase.execute({ ...CMD, canReply: false })).resolves.toBe('handoff');

    expect(gateway.replies).toEqual([]);
    expect(gateway.allLabels).toContain('necesita-humano');
  });

  // ── W2 ────────────────────────────────────────────────────────────────────
  it('W2: `assigneeName` AUSENTE del payload ⇒ se asume ASIGNADO (fail-closed)', async () => {
    const { useCase, gateway, runs } = await harness();
    const sinAssignee = { ...CMD };
    delete (sinAssignee as { assigneeName?: string | null }).assigneeName;

    await expect(useCase.execute(sinAssignee)).resolves.toBe('noop');

    expect(gateway.replies).toEqual([]);
    const { items } = await runs.list({ outcome: 'noop' });
    expect(items[0].reason).toBe('agent_active');
  });

  it('W2: `assigneeName: null` explícito sigue siendo SIN asignar', async () => {
    const { useCase } = await harness();

    await expect(useCase.execute({ ...CMD, assigneeName: null })).resolves.toBe('replied');
  });
});

/**
 * ═══ FIX WAVE 2 (re-verificación adversarial 2026-09-05) ════════════════════
 *
 * Dos regresiones que introdujo la PROPIA fix wave anterior (N1/N2) y un agujero del
 * invariante de hechos internos (N3). La lección de la re-verificación: dos fixes correctos
 * por separado pueden mentir juntos — D12.7 mandó los pagos de ayer a
 * `comprobante_transferencia` cuando esa rama era MUDA, y D12.5 la hizo HABLAR.
 */
describe('ReplyWithAssistant — fix wave 2: acuse honesto, guard con negación y hechos internos', () => {
  const ROLES_W2 = [
    {
      roleKey: 'comprobante_mp',
      actionKey: 'whatsapp_reply',
      dataSourceKeys: ['cliente.recibos_hoy', 'cliente.saldo', 'cliente.facturas'],
    },
    {
      roleKey: 'comprobante_transferencia',
      actionKey: 'handoff',
      labels: ['administracion'],
      unassign: true,
      dataSourceKeys: ['cliente.recibos_hoy', 'cliente.saldo'],
    },
  ];
  const ACCIONES = ['whatsapp_reply', 'private_note', 'handoff'];

  // ── N1 ────────────────────────────────────────────────────────────────────
  it('N1: un pago por LINK de MercadoPago de ayer no recibe un acuse que afirme "transferencia"', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES_W2,
      factsByKey: {
        // Camino W5 REAL: el recibo de MercadoPago existe, pero es de AYER 23:55 ⇒ queda fuera
        // de `deHoy` ⇒ `encontrado:false` ⇒ fila 1 del selector ⇒ `comprobante_transferencia`.
        'cliente.recibos_hoy': {
          disponible: true,
          recibos: [
            {
              fecha: '03-09-2026',
              hora: '23:55',
              recaudador: 'mercadopago',
              importe: 41410.56,
              referencias: ['MercadoPago: 177332834792'],
              esDeAyer: true,
            },
          ],
          matchOperacion: { operacion: '177332834792', encontrado: false },
          posibleDoblePago: false,
        },
        'cliente.saldo': { disponible: true, saldo: 31178, moneda: 'ARS', tieneDeuda: true },
      },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');

    const dicho = gateway.replies.join('\n');
    expect(dicho).toContain('Recibimos tu comprobante');
    expect(dicho).toContain('operación 177332834792');
    // El MEDIO no se afirma: pagó por link, no transfirió.
    expect(dicho.toLowerCase()).not.toContain('transferencia');
    expect(dicho.toLowerCase()).not.toContain('no por link');
    // Y el saldo va CALIFICADO: todavía incluye el pago que el cliente acaba de mostrar.
    expect(dicho).toContain('sin contar este pago');
    expect(dicho).toContain('31.178,00');
    expect(dicho).toMatch(/imputa a mano/i);
    // La derivación no cambia.
    expect(gateway.allLabels).toEqual(expect.arrayContaining(['administracion', 'necesita-humano']));
    expect(gateway.unassignCount).toBe(1);
  });

  it('N1: con la cuenta al día, el acuse dice "figura al día" y sigue calificando el pago', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES_W2,
      factsByKey: {
        'cliente.recibos_hoy': {
          disponible: false,
          motivo: 'recibos_no_disponibles',
          guia: 'no afirmes',
        },
        'cliente.saldo': { disponible: true, saldo: 0, moneda: null, tieneDeuda: false },
      },
    });

    await useCase.execute(CMD);

    const dicho = gateway.replies.join('\n');
    expect(dicho).toMatch(/figura al día/i);
    expect(dicho).toContain('sin contar este pago');
    expect(dicho.toLowerCase()).not.toContain('transferencia');
  });

  it('N1: sin `cliente.saldo` disponible, el acuse NO afirma nada sobre el saldo', async () => {
    const { useCase, gateway } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      enabledActions: ACCIONES,
      roleIntents: ROLES_W2,
      factsByKey: {
        'cliente.recibos_hoy': { disponible: false, motivo: 'recibos_no_disponibles', guia: 'no afirmes' },
        'cliente.saldo': { disponible: false, motivo: 'saldo_desactualizado', guia: 'no menciones importes' },
      },
    });

    await useCase.execute(CMD);

    const dicho = gateway.replies.join('\n');
    expect(dicho).toContain('Recibimos tu comprobante');
    expect(dicho).not.toMatch(/saldo|al d[ií]a/i);
  });

  // ── N2 ────────────────────────────────────────────────────────────────────
  it('N2: la respuesta CORRECTA del cliente al día se ENVÍA (no se descarta por "pendientes")', async () => {
    const { useCase, gateway, runs } = await harness({
      customerText: '¿tengo algo para pagar?',
      facts: { disponible: true, saldo: 0, moneda: null, tieneDeuda: false },
      generate: { kind: 'text', text: 'No tenés facturas pendientes, estás al día.' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');

    expect(gateway.replies).toEqual(['No tenés facturas pendientes, estás al día.']);
    const { items } = await runs.list({});
    expect(items[0].reason).not.toBe('contradicts_balance');
  });

  it('N2: con deuda, "todavía no estás al día" también se envía', async () => {
    const { useCase, gateway } = await harness({
      facts: { disponible: true, saldo: 45000, moneda: 'ARS', tieneDeuda: true },
      generate: { kind: 'text', text: 'Todavía no estás al día: te queda un saldo por regularizar.' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('replied');
    expect(gateway.replies).toHaveLength(1);
  });

  it('N2: el guard sigue frenando la afirmación FALSA de "estás al día" con deuda', async () => {
    const { useCase, gateway, runs } = await harness({
      facts: { disponible: true, saldo: 45000, moneda: 'ARS', tieneDeuda: true },
      generate: { kind: 'text', text: 'Estás al día, no hace falta que pagues nada.' },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');
    expect(gateway.replies).toEqual([]);
    const { items } = await runs.list({ outcome: 'handoff' });
    expect(items[0].reason).toBe('contradicts_balance');
  });

  // ── N3 ────────────────────────────────────────────────────────────────────
  it('N3: un hecho interno DENTRO de un array tampoco llega al modelo ni al whitelist', async () => {
    const vistoPorElModelo: Array<Record<string, unknown> | null> = [];
    const { useCase, gateway } = await harness({
      factsByKey: {
        'cliente.facturas': {
          disponible: true,
          cantidad: 1,
          facturas: [
            {
              tipo: 'FC A',
              numero: '0001-1',
              vencimiento: '2026-09-10',
              saldo: 1000,
              pdfUrl: null,
              couponPdfUrl: null,
              paymentUrl: null,
              // El invariante D12.3 dice "NUNCA llega al modelo": también adentro de un array.
              _interno: 987654,
              _anidado: { _masAdentro: 987654 },
            },
          ],
          linkPagoTotal: null,
        },
      },
      generate: { kind: 'text', text: 'Te paso el detalle.' },
      onGenerate: (facts) => vistoPorElModelo.push(facts),
    });

    await useCase.execute(CMD);

    expect(vistoPorElModelo).toHaveLength(1);
    const serializado = JSON.stringify(vistoPorElModelo[0]);
    expect(serializado).not.toContain('987654');
    expect(serializado).not.toContain('_interno');
    expect(serializado).not.toContain('_masAdentro');
    // Y el número interno NO quedó autorizado: si estuviera en el whitelist, un texto del
    // modelo con esa cifra pasaría SEC-4 (el pin real de la fuga).
    expect(gateway.replies.join('\n')).not.toContain('987654');
  });

  it('N3: el filtro no rompe los arrays legítimos — las facturas siguen llegando enteras', async () => {
    const vistoPorElModelo: Array<Record<string, unknown> | null> = [];
    const { useCase } = await harness({
      factsByKey: {
        'cliente.facturas': {
          disponible: true,
          cantidad: 2,
          facturas: [
            { tipo: 'FC A', numero: '0001-1', vencimiento: '2026-09-10', saldo: 1000, pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
            { tipo: 'FC A', numero: '0001-2', vencimiento: '2026-10-10', saldo: 2000, pdfUrl: null, couponPdfUrl: null, paymentUrl: null },
          ],
          linkPagoTotal: null,
        },
      },
      generate: { kind: 'text', text: 'Te paso el detalle.' },
      onGenerate: (facts) => vistoPorElModelo.push(facts),
    });

    await useCase.execute(CMD);

    const facturas = (vistoPorElModelo[0]?.['cliente.facturas'] as Record<string, unknown>).facturas as unknown[];
    expect(facturas).toHaveLength(2);
    expect(facturas[1]).toMatchObject({ numero: '0001-2', saldo: 2000 });
  });

  // ── N6 ────────────────────────────────────────────────────────────────────
  it('N6 (trampa de config, DOCUMENTADA): si la acción de la primera intent no está habilitada, el selector D11 no corre', async () => {
    // No hay seed de intents en el repo (las carga el operador en la Fase 8), así que el
    // invariante no se puede assertear contra un archivo. Lo que SÍ se puede pinear es la
    // consecuencia: la Etapa 3 corta ANTES del selector, y por eso la conversación tiene que
    // salir igual con el label de área y desasignada (W3) — si no, queda invisible en la cola.
    const { useCase, gateway, runs } = await harness({
      customerText: 'te paso el comprobante',
      attachmentFilenames: ['comprobante_177332834792.pdf'],
      // `whatsapp_reply` NO habilitada: el perfil sigue en modo borrador.
      enabledActions: ['private_note', 'handoff'],
      roleIntents: ROLES_W2,
      factsByKey: {
        'cliente.recibos_hoy': { disponible: false, motivo: 'recibos_no_disponibles', guia: 'no afirmes' },
        'cliente.saldo': { disponible: true, saldo: 31178, moneda: 'ARS', tieneDeuda: true },
      },
    });

    await expect(useCase.execute(CMD)).resolves.toBe('handoff');

    expect(gateway.replies).toEqual([]);
    expect(gateway.allLabels).toContain('necesita-humano');
    const { items } = await runs.list({ outcome: 'handoff' });
    expect(items[0].reason).toBe('action_not_enabled');
  });
});
