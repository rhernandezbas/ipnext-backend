import {
  InMemoryAssistantIntentRepository,
  InMemoryAssistantProfileRepository,
} from '@infrastructure/adapters/in-memory/InMemoryAssistantProfileRepository';
import { InMemoryAssistantCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantCatalogRepository';
import { CreateAssistantProfile } from '@application/use-cases/assistant/CreateAssistantProfile';
import { UpdateAssistantProfile } from '@application/use-cases/assistant/UpdateAssistantProfile';
import { CreateAssistantIntent } from '@application/use-cases/assistant/CreateAssistantIntent';
import { UpdateAssistantIntent } from '@application/use-cases/assistant/UpdateAssistantIntent';
import { ListAssistantCatalogs } from '@application/use-cases/assistant/ListAssistantCatalogs';
import {
  AssistantActionRequiresEvalError,
  AssistantIntentNameConflictError,
  AssistantIntentNotFoundError,
  AssistantProfileAlreadyExistsError,
  AssistantProfileNotFoundError,
  UnknownAssistantActionError,
  UnknownAssistantDataSourceError,
} from '@domain/errors/assistant';
import type { AssistantEvalGate } from '@domain/ports/AssistantEvalGate';

/**
 * ai-assistant-multiagent (Batch 2) — use cases de CONFIGURACIÓN.
 *
 * Testeados contra adapters in-memory, NUNCA mockeando Prisma. Acá vive la última barrera
 * antes de que una key inventada quede persistida: si esta capa deja pasar basura, el motor
 * la ejecuta en producción.
 */

/** Gate de eval configurable — Batch 8 lo implementa de verdad contra las corridas reales. */
const evalGate = (hasRun: boolean): AssistantEvalGate => ({
  hasRecordedRun: async () => hasRun,
});

describe('CreateAssistantProfile', () => {
  let profiles: InMemoryAssistantProfileRepository;
  let useCase: CreateAssistantProfile;

  beforeEach(() => {
    profiles = new InMemoryAssistantProfileRepository();
    useCase = new CreateAssistantProfile(profiles);
  });

  it('CFG-1: el perfil creado nace APAGADO', async () => {
    const profile = await useCase.execute({ areaId: 'area-1' });

    expect(profile.enabled).toBe(false);
  });

  it('CFG-1: ACT-2 — nace sin ninguna acción habilitada', async () => {
    const profile = await useCase.execute({ areaId: 'area-1' });

    expect(profile.enabledActions).toEqual([]);
  });

  it('CFG-1: un segundo perfil para la misma área es conflicto tipado (409)', async () => {
    await useCase.execute({ areaId: 'area-1' });

    await expect(useCase.execute({ areaId: 'area-1' })).rejects.toBeInstanceOf(
      AssistantProfileAlreadyExistsError,
    );
  });

  it('devuelve un DTO, no la entidad cruda del repo', async () => {
    const profile = await useCase.execute({ areaId: 'area-1', persona: 'Cordial' });

    expect(profile).toMatchObject({ areaId: 'area-1', persona: 'Cordial', enabled: false });
  });
});

describe('UpdateAssistantProfile', () => {
  let profiles: InMemoryAssistantProfileRepository;
  let catalog: InMemoryAssistantCatalogRepository;
  let useCase: UpdateAssistantProfile;
  let profileId: string;

  beforeEach(async () => {
    profiles = new InMemoryAssistantProfileRepository();
    catalog = new InMemoryAssistantCatalogRepository();
    useCase = new UpdateAssistantProfile(profiles, catalog, evalGate(false));
    profileId = (await profiles.create({ areaId: 'area-1' })).id;
  });

  it('habilita el perfil', async () => {
    const updated = await useCase.execute(profileId, { enabled: true });

    expect(updated.enabled).toBe(true);
  });

  it('perfil inexistente ⇒ error tipado (404)', async () => {
    await expect(useCase.execute('no-existe', { enabled: true })).rejects.toBeInstanceOf(
      AssistantProfileNotFoundError,
    );
  });

  // ── CFG-3: validación de acciones contra el catálogo ─────────────────────
  it('CFG-3: una actionKey inventada se rechaza (400), no se persiste', async () => {
    await expect(
      useCase.execute(profileId, { enabledActions: ['volar_el_router'] }),
    ).rejects.toBeInstanceOf(UnknownAssistantActionError);

    expect((await profiles.findById(profileId))?.enabledActions).toEqual([]);
  });

  it('CFG-3: acciones green se habilitan sin fricción', async () => {
    const updated = await useCase.execute(profileId, {
      enabledActions: ['private_note', 'suggest_area'],
    });

    expect(updated.enabledActions).toEqual(['private_note', 'suggest_area']);
  });

  it('CFG-3: una acción yellow se habilita sin necesitar eval', async () => {
    const updated = await useCase.execute(profileId, { enabledActions: ['whatsapp_reply'] });

    expect(updated.enabledActions).toEqual(['whatsapp_reply']);
  });

  // ── EVAL-2: candado de las acciones red ──────────────────────────────────
  it('EVAL-2: habilitar resolve_conversation SIN eval registrado se rechaza', async () => {
    await expect(
      useCase.execute(profileId, { enabledActions: ['resolve_conversation'] }),
    ).rejects.toBeInstanceOf(AssistantActionRequiresEvalError);
  });

  it('EVAL-2: las acciones green/yellow NO requieren eval (sólo las red)', async () => {
    const updated = await useCase.execute(profileId, {
      enabledActions: ['private_note', 'apply_label', 'suggest_area', 'whatsapp_reply'],
    });

    expect(updated.enabledActions).toHaveLength(4);
  });

  it('EVAL-2: el rechazo NO persiste nada (ni las acciones válidas del mismo request)', async () => {
    await expect(
      useCase.execute(profileId, { enabledActions: ['private_note', 'resolve_conversation'] }),
    ).rejects.toBeInstanceOf(AssistantActionRequiresEvalError);

    expect((await profiles.findById(profileId))?.enabledActions).toEqual([]);
  });

  it('EVAL-2: CON eval registrado, la acción red se habilita', async () => {
    const withEval = new UpdateAssistantProfile(profiles, catalog, evalGate(true));

    const updated = await withEval.execute(profileId, { enabledActions: ['resolve_conversation'] });

    expect(updated.enabledActions).toEqual(['resolve_conversation']);
  });

  it('EVAL-2: mantener una acción red ya habilitada no re-pide eval', async () => {
    const withEval = new UpdateAssistantProfile(profiles, catalog, evalGate(true));
    await withEval.execute(profileId, { enabledActions: ['resolve_conversation'] });

    // el gate vuelve a estar en false, pero la acción YA estaba habilitada
    const updated = await useCase.execute(profileId, {
      enabledActions: ['resolve_conversation', 'private_note'],
    });

    expect(updated.enabledActions).toEqual(['resolve_conversation', 'private_note']);
  });
});

describe('CreateAssistantIntent', () => {
  let profiles: InMemoryAssistantProfileRepository;
  let intents: InMemoryAssistantIntentRepository;
  let catalog: InMemoryAssistantCatalogRepository;
  let useCase: CreateAssistantIntent;
  let profileId: string;

  beforeEach(async () => {
    profiles = new InMemoryAssistantProfileRepository();
    intents = new InMemoryAssistantIntentRepository();
    catalog = new InMemoryAssistantCatalogRepository();
    useCase = new CreateAssistantIntent(profiles, intents, catalog);
    profileId = (await profiles.create({ areaId: 'area-1' })).id;
  });

  const base = {
    name: 'estado de cuenta',
    description: 'El cliente pregunta cuánto debe',
    actionKey: 'whatsapp_reply',
  };

  it('CFG-2: crea la intención sin deploy y queda disponible', async () => {
    const intent = await useCase.execute({ ...base, profileId });

    expect(intent.name).toBe('estado de cuenta');
    expect(await intents.listEnabledByProfileId(profileId)).toHaveLength(1);
  });

  it('CFG-2: perfil inexistente ⇒ 404', async () => {
    await expect(useCase.execute({ ...base, profileId: 'no-existe' })).rejects.toBeInstanceOf(
      AssistantProfileNotFoundError,
    );
  });

  it('CFG-2: nombre duplicado en el mismo perfil ⇒ conflicto tipado (409)', async () => {
    await useCase.execute({ ...base, profileId });

    await expect(useCase.execute({ ...base, profileId })).rejects.toBeInstanceOf(
      AssistantIntentNameConflictError,
    );
  });

  // ── CFG-3: validación de fuentes ─────────────────────────────────────────
  it('CFG-3: una dataSourceKey inventada se rechaza (400) y NO persiste', async () => {
    await expect(
      useCase.execute({ ...base, profileId, dataSourceKeys: ['cliente.tarjeta'] }),
    ).rejects.toBeInstanceOf(UnknownAssistantDataSourceError);

    expect(await intents.listByProfileId(profileId)).toEqual([]);
  });

  it('CFG-3: el error reporta EXACTAMENTE cuáles keys fallaron', async () => {
    await expect(
      useCase.execute({
        ...base,
        profileId,
        dataSourceKeys: ['cliente.saldo', 'cliente.tarjeta', 'inventada.key'],
      }),
    ).rejects.toMatchObject({ keys: ['cliente.tarjeta', 'inventada.key'] });
  });

  it('CFG-3: una actionKey inventada se rechaza', async () => {
    await expect(
      useCase.execute({ ...base, profileId, actionKey: 'volar_el_router' }),
    ).rejects.toBeInstanceOf(UnknownAssistantActionError);
  });

  it('CFG-3: se puede referenciar una fuente DESHABILITADA (noc.cortes)', async () => {
    // Existe en el catálogo, sólo está apagada: configurarla es válido, resolverla no.
    // Así, prender la fuente después NO obliga a re-editar las intenciones.
    const intent = await useCase.execute({
      ...base,
      profileId,
      dataSourceKeys: ['noc.cortes'],
    });

    expect(intent.dataSourceKeys).toEqual(['noc.cortes']);
  });
});

describe('UpdateAssistantIntent', () => {
  let intents: InMemoryAssistantIntentRepository;
  let catalog: InMemoryAssistantCatalogRepository;
  let useCase: UpdateAssistantIntent;
  let intentId: string;

  beforeEach(async () => {
    intents = new InMemoryAssistantIntentRepository();
    catalog = new InMemoryAssistantCatalogRepository();
    useCase = new UpdateAssistantIntent(intents, catalog);
    intentId = (
      await intents.create({
        profileId: 'profile-1',
        name: 'estado de cuenta',
        description: 'cuánto debe',
        actionKey: 'whatsapp_reply',
      })
    ).id;
  });

  it('apaga la intención sin borrarla (RTR-2)', async () => {
    const updated = await useCase.execute(intentId, { enabled: false });

    expect(updated.enabled).toBe(false);
    expect(await intents.listEnabledByProfileId('profile-1')).toEqual([]);
  });

  it('intención inexistente ⇒ 404', async () => {
    await expect(useCase.execute('no-existe', { enabled: false })).rejects.toBeInstanceOf(
      AssistantIntentNotFoundError,
    );
  });

  it('CFG-3: valida las keys también en el update, no sólo en el alta', async () => {
    await expect(
      useCase.execute(intentId, { dataSourceKeys: ['inventada'] }),
    ).rejects.toBeInstanceOf(UnknownAssistantDataSourceError);
  });

  it('CFG-3: valida la actionKey en el update', async () => {
    await expect(useCase.execute(intentId, { actionKey: 'inventada' })).rejects.toBeInstanceOf(
      UnknownAssistantActionError,
    );
  });
});

describe('ListAssistantCatalogs', () => {
  it('CFG-3: expone fuentes y acciones con su estado y riesgo', async () => {
    const useCase = new ListAssistantCatalogs(new InMemoryAssistantCatalogRepository());

    const { dataSources, actions } = await useCase.execute();

    expect(dataSources).toHaveLength(4);
    expect(actions).toHaveLength(5);
    expect(dataSources.find((s) => s.key === 'noc.cortes')?.enabled).toBe(false);
    expect(actions.find((a) => a.key === 'resolve_conversation')?.riskLevel).toBe('red');
    expect(actions.find((a) => a.key === 'private_note')?.riskLevel).toBe('green');
  });
});
