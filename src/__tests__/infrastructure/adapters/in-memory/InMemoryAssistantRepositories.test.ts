import {
  InMemoryAssistantProfileRepository,
  InMemoryAssistantIntentRepository,
} from '@infrastructure/adapters/in-memory/InMemoryAssistantProfileRepository';
import { InMemoryAssistantCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantCatalogRepository';
import { InMemoryAssistantRunRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantRunRepository';

/**
 * ai-assistant-multiagent — contrato de los repos in-memory (Batch 1, T1.4).
 *
 * Estos tests son el CONTRATO que el adapter Prisma también debe cumplir: los use cases se
 * testean contra in-memory (nunca mockeando Prisma), así que si los dos adapters divergen,
 * la suite pasa en verde y prod se rompe. Cada bloque referencia su requisito del spec.
 */
describe('InMemoryAssistantProfileRepository', () => {
  let repo: InMemoryAssistantProfileRepository;

  beforeEach(() => {
    repo = new InMemoryAssistantProfileRepository();
  });

  // ── CFG-1 ────────────────────────────────────────────────────────────────
  it('CFG-1: un perfil recién creado nace APAGADO', async () => {
    const profile = await repo.create({ areaId: 'area-1' });

    expect(profile.enabled).toBe(false);
  });

  it('CFG-1: no se puede forzar enabled en el alta (el input no lo acepta)', async () => {
    // El tipo no declara `enabled` — este test documenta la intención: habilitar es
    // SIEMPRE un acto posterior y explícito, nunca un efecto colateral del alta.
    const profile = await repo.create({ areaId: 'area-1', persona: 'Cordial y breve' });

    expect(profile.enabled).toBe(false);
    expect(profile.persona).toBe('Cordial y breve');
  });

  it('CFG-1: findByAreaId devuelve null cuando el área no tiene perfil (no lanza)', async () => {
    await expect(repo.findByAreaId('area-inexistente')).resolves.toBeNull();
  });

  it('CFG-1: un área tiene a lo sumo UN perfil', async () => {
    await repo.create({ areaId: 'area-1' });

    await expect(repo.create({ areaId: 'area-1' })).rejects.toThrow();
  });

  it('habilita el perfil por update explícito', async () => {
    const created = await repo.create({ areaId: 'area-1' });

    const updated = await repo.update(created.id, { enabled: true });

    expect(updated?.enabled).toBe(true);
    expect((await repo.findByAreaId('area-1'))?.enabled).toBe(true);
  });

  it('update parcial no pisa los campos ausentes', async () => {
    const created = await repo.create({ areaId: 'area-1', persona: 'original', model: 'm1' });

    await repo.update(created.id, { enabled: true });

    const after = await repo.findById(created.id);
    expect(after?.persona).toBe('original');
    expect(after?.model).toBe('m1');
  });

  it('enabledActions se REEMPLAZA completo, no se mergea', async () => {
    const created = await repo.create({ areaId: 'area-1' });
    await repo.update(created.id, { enabledActions: ['private_note', 'suggest_area'] });

    await repo.update(created.id, { enabledActions: ['private_note'] });

    expect((await repo.findById(created.id))?.enabledActions).toEqual(['private_note']);
  });

  it('enabledActions nace vacío — ACT-2: instalación nueva sin ninguna acción activa', async () => {
    const profile = await repo.create({ areaId: 'area-1' });

    expect(profile.enabledActions).toEqual([]);
  });

  it('update de un perfil inexistente devuelve null (el caller decide el 404)', async () => {
    await expect(repo.update('no-existe', { enabled: true })).resolves.toBeNull();
  });
});

describe('InMemoryAssistantIntentRepository', () => {
  let intents: InMemoryAssistantIntentRepository;

  beforeEach(() => {
    intents = new InMemoryAssistantIntentRepository();
  });

  const base = {
    profileId: 'profile-1',
    description: 'El cliente pregunta cuánto debe',
    actionKey: 'whatsapp_reply',
  };

  // ── CFG-2 ────────────────────────────────────────────────────────────────
  it('CFG-2: alta de intención sin deploy — queda disponible de inmediato', async () => {
    await intents.create({ ...base, name: 'estado de cuenta' });

    const list = await intents.listByProfileId('profile-1');
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('estado de cuenta');
  });

  it('CFG-2: una intención nace habilitada (a diferencia del perfil)', async () => {
    const intent = await intents.create({ ...base, name: 'estado de cuenta' });

    expect(intent.enabled).toBe(true);
  });

  it('CFG-2: nombre duplicado en el MISMO perfil es conflicto', async () => {
    await intents.create({ ...base, name: 'estado de cuenta' });

    await expect(intents.create({ ...base, name: 'estado de cuenta' })).rejects.toThrow();
  });

  it('CFG-2: el mismo nombre en OTRO perfil es válido (los perfiles son independientes)', async () => {
    await intents.create({ ...base, name: 'estado de cuenta' });

    await expect(
      intents.create({ ...base, profileId: 'profile-2', name: 'estado de cuenta' }),
    ).resolves.toBeDefined();
  });

  // ── RTR-2 ────────────────────────────────────────────────────────────────
  it('RTR-2: listEnabledByProfileId devuelve SÓLO las habilitadas', async () => {
    await intents.create({ ...base, name: 'activa' });
    await intents.create({ ...base, name: 'apagada', enabled: false });

    const enabled = await intents.listEnabledByProfileId('profile-1');

    expect(enabled.map((i) => i.name)).toEqual(['activa']);
  });

  it('RTR-2: aislamiento entre perfiles — nunca devuelve intents de otro perfil', async () => {
    await intents.create({ ...base, name: 'de-facturacion' });
    await intents.create({ ...base, profileId: 'profile-2', name: 'de-ventas' });

    const enabled = await intents.listEnabledByProfileId('profile-1');

    expect(enabled.map((i) => i.name)).toEqual(['de-facturacion']);
  });

  it('RTR-2: apagar una intención la saca del universo del clasificador', async () => {
    const intent = await intents.create({ ...base, name: 'estado de cuenta' });

    await intents.update(intent.id, { enabled: false });

    await expect(intents.listEnabledByProfileId('profile-1')).resolves.toEqual([]);
    // pero la UI la sigue viendo, para poder prenderla de nuevo
    await expect(intents.listByProfileId('profile-1')).resolves.toHaveLength(1);
  });

  it('listByProfileId devuelve habilitadas y apagadas (la UI necesita ambas)', async () => {
    await intents.create({ ...base, name: 'activa' });
    await intents.create({ ...base, name: 'apagada', enabled: false });

    await expect(intents.listByProfileId('profile-1')).resolves.toHaveLength(2);
  });

  it('borra una intención y desaparece del perfil', async () => {
    const intent = await intents.create({ ...base, name: 'estado de cuenta' });

    await expect(intents.delete(intent.id)).resolves.toBe(true);
    await expect(intents.listByProfileId('profile-1')).resolves.toEqual([]);
  });

  it('dataSourceKeys y examples nacen vacíos si no se especifican', async () => {
    const intent = await intents.create({ ...base, name: 'estado de cuenta' });

    expect(intent.dataSourceKeys).toEqual([]);
    expect(intent.examples).toEqual([]);
  });
});

describe('InMemoryAssistantCatalogRepository', () => {
  let catalog: InMemoryAssistantCatalogRepository;

  beforeEach(() => {
    catalog = new InMemoryAssistantCatalogRepository();
  });

  // ── CFG-3 ────────────────────────────────────────────────────────────────
  it('CFG-3: el seed trae las 4 fuentes y las 5 acciones', async () => {
    await expect(catalog.listDataSources()).resolves.toHaveLength(4);
    await expect(catalog.listActions()).resolves.toHaveLength(5);
  });

  it('D11: todas las acciones operan sobre la conversación de Chatwoot', async () => {
    const actions = await catalog.listActions();

    expect(actions.map((a) => a.key).sort()).toEqual([
      'apply_label',
      'private_note',
      'resolve_conversation',
      'suggest_area',
      'whatsapp_reply',
    ]);
  });

  it('D2: noc.cortes viene DESHABILITADA (el hub NOC está en modo oscuro)', async () => {
    const sources = await catalog.listDataSources();

    expect(sources.find((s) => s.key === 'noc.cortes')?.enabled).toBe(false);
  });

  it('ACT-2: la acción red está en el catálogo pero no se habilita sola', async () => {
    const actions = await catalog.listActions();

    const red = actions.filter((a) => a.riskLevel === 'red').map((a) => a.key);
    // Marcar resuelta una conversación cuyo pedido seguía vivo entierra el reclamo.
    expect(red.sort()).toEqual(['resolve_conversation']);
  });

  it('CFG-3: una key inventada se reporta como faltante (el caller responde 400)', async () => {
    const missing = await catalog.findMissingDataSourceKeys(['cliente.saldo', 'cliente.tarjeta']);

    expect(missing).toEqual(['cliente.tarjeta']);
  });

  it('CFG-3: keys todas válidas ⇒ nada faltante', async () => {
    await expect(
      catalog.findMissingDataSourceKeys(['cliente.saldo', 'os.abiertas']),
    ).resolves.toEqual([]);
  });

  it('CFG-3: actionKey inventada se reporta como faltante', async () => {
    await expect(catalog.findMissingActionKeys(['volar_el_router'])).resolves.toEqual([
      'volar_el_router',
    ]);
  });

  it('CFG-3 scenario 2: una fuente deshabilitada se filtra, el resto sobrevive', async () => {
    const enabled = await catalog.filterEnabledDataSourceKeys(['cliente.saldo', 'noc.cortes']);

    expect(enabled).toEqual(['cliente.saldo']);
  });

  it('CFG-3: habilitar noc.cortes la vuelve resoluble (sin tocar código)', async () => {
    await catalog.setDataSourceEnabled('noc.cortes', true);

    await expect(catalog.filterEnabledDataSourceKeys(['noc.cortes'])).resolves.toEqual([
      'noc.cortes',
    ]);
  });

  it('toggle de una key inexistente devuelve null', async () => {
    await expect(catalog.setDataSourceEnabled('no.existe', true)).resolves.toBeNull();
  });
});

describe('InMemoryAssistantRunRepository', () => {
  let runs: InMemoryAssistantRunRepository;

  beforeEach(() => {
    runs = new InMemoryAssistantRunRepository();
  });

  const baseRun = {
    profileId: 'profile-1',
    areaId: 'area-1',
    subjectType: 'conversation' as const,
    subjectId: 'conv-1',
    intentName: 'estado de cuenta',
    dataSources: ['cliente.saldo'],
    actionKey: 'whatsapp_reply',
    outcome: 'replied' as const,
    reason: null,
    latencyMs: 820,
  };

  // ── OBS-1 ────────────────────────────────────────────────────────────────
  it('OBS-1: registra la corrida y la devuelve con id y timestamp', async () => {
    const run = await runs.record(baseRun);

    expect(run.id).toBeTruthy();
    expect(run.createdAt).toBeTruthy();
    expect(run.outcome).toBe('replied');
  });

  it('OBS-1: registra el handoff con su motivo, sin contenido del cliente', async () => {
    await runs.record({
      ...baseRun,
      intentName: null,
      actionKey: null,
      outcome: 'handoff',
      reason: 'no_intent_match',
    });

    const { items } = await runs.list({});
    expect(items[0].intentName).toBeNull();
    expect(items[0].reason).toBe('no_intent_match');
  });

  it('OBS-1: rejected_numbers queda registrado como outcome propio (métrica de SEC-4)', async () => {
    await runs.record({ ...baseRun, outcome: 'rejected_numbers', reason: 'number_not_in_facts' });

    const { items } = await runs.list({ outcome: 'rejected_numbers' });
    expect(items).toHaveLength(1);
  });

  it('filtra por área', async () => {
    await runs.record(baseRun);
    await runs.record({ ...baseRun, areaId: 'area-2', subjectId: 'conv-2' });

    const { items, total } = await runs.list({ areaId: 'area-2' });

    expect(total).toBe(1);
    expect(items[0].subjectId).toBe('conv-2');
  });

  it('filtra por sujeto (para ver qué hizo el agente en una conversación puntual)', async () => {
    await runs.record(baseRun);
    await runs.record({ ...baseRun, subjectId: 'conv-9' });

    const { items } = await runs.list({ subjectType: 'conversation', subjectId: 'conv-9' });

    expect(items).toHaveLength(1);
    expect(items[0].subjectId).toBe('conv-9');
  });

  it('devuelve las más recientes primero', async () => {
    await runs.record({ ...baseRun, subjectId: 'primera' });
    await runs.record({ ...baseRun, subjectId: 'segunda' });

    const { items } = await runs.list({});

    expect(items[0].subjectId).toBe('segunda');
  });

  it('respeta limit y offset', async () => {
    await runs.record({ ...baseRun, subjectId: 'a' });
    await runs.record({ ...baseRun, subjectId: 'b' });
    await runs.record({ ...baseRun, subjectId: 'c' });

    const { items, total } = await runs.list({ limit: 2, offset: 1 });

    expect(total).toBe(3);
    expect(items).toHaveLength(2);
  });
});
