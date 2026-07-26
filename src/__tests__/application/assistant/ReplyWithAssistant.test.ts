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
import type { AssistantThreadReader } from '@domain/ports/AssistantThreadReader';
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
  facts?: Record<string, unknown>;
  customerText?: string;
  intentActionKey?: string;
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
    dataSourceKeys: ['cliente.saldo'],
    actionKey: opts.intentActionKey ?? 'whatsapp_reply',
  });

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
    readRecentTurns: async () => [
      { role: 'customer', text: opts.customerText ?? '¿cuánto debo?' },
    ],
  };

  const clients: AssistantClientResolver = {
    resolveByPhone: async () => ({
      clientId: 'client-1',
      optedOut: opts.optedOut ?? false,
      identityValues: ['Juan Pérez'],
    }),
  };

  const registry: AssistantDataSourceRegistry = {
    get: (key) =>
      key === 'cliente.saldo'
        ? { key, resolve: async () => opts.facts ?? { saldo: 45000 } }
        : null,
    keys: () => ['cliente.saldo'],
  };

  const runtime: AssistantRuntime = {
    classify: async () => opts.classify ?? { kind: 'intent', key: intent.id },
    generate: async () => opts.generate ?? { kind: 'text', text: 'Tu saldo es $45000.' },
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

  return { useCase, gateway, runs, profiles, intents, profile, intent, routing };
}

const CMD: ReplyWithAssistantCommand = {
  conversationId: 'conv-1',
  areaId: 'area-1',
  direction: 'inbound',
  isPrivate: false,
  canReply: true,
  contactPhone: '+5492964123456',
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
