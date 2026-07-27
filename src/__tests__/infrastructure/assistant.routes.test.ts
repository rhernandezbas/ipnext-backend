import express from 'express';
import request from 'supertest';
import { createAssistantRouter } from '@infrastructure/http/routes/assistant.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { CreateAssistantProfile } from '@application/use-cases/assistant/CreateAssistantProfile';
import { UpdateAssistantProfile } from '@application/use-cases/assistant/UpdateAssistantProfile';
import { GetAssistantConfig } from '@application/use-cases/assistant/GetAssistantConfig';
import { CreateAssistantIntent } from '@application/use-cases/assistant/CreateAssistantIntent';
import { UpdateAssistantIntent } from '@application/use-cases/assistant/UpdateAssistantIntent';
import { DeleteAssistantIntent } from '@application/use-cases/assistant/DeleteAssistantIntent';
import { ListAssistantCatalogs } from '@application/use-cases/assistant/ListAssistantCatalogs';
import { ListAssistantRuns } from '@application/use-cases/assistant/ListAssistantRuns';
import { GetAssistantProviderConfig } from '@application/use-cases/assistant/GetAssistantProviderConfig';
import { UpdateAssistantProviderConfig } from '@application/use-cases/assistant/UpdateAssistantProviderConfig';
import { TestAssistantConnection } from '@application/use-cases/assistant/TestAssistantConnection';
import { GetAssistantRoutingConfig } from '@application/use-cases/assistant/GetAssistantRoutingConfig';
import { UpdateAssistantRoutingConfig } from '@application/use-cases/assistant/UpdateAssistantRoutingConfig';
import { RecordAssistantEvalRun } from '@application/use-cases/assistant/RecordAssistantEvalRun';
import { ListAssistantEvalRuns } from '@application/use-cases/assistant/ListAssistantEvalRuns';
import { SetAssistantDataSourceEnabled } from '@application/use-cases/assistant/SetAssistantDataSourceEnabled';
import { InMemoryAssistantEvalRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantEvalRepository';
import { InMemoryAssistantRoutingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantRoutingConfigRepository';
import { InMemoryAssistantProviderConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantProviderConfigRepository';
import {
  InMemoryAssistantIntentRepository,
  InMemoryAssistantProfileRepository,
} from '@infrastructure/adapters/in-memory/InMemoryAssistantProfileRepository';
import { InMemoryAssistantCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantCatalogRepository';
import { InMemoryAssistantRunRepository } from '@infrastructure/adapters/in-memory/InMemoryAssistantRunRepository';
import type { AssistantEvalGate } from '@domain/ports/AssistantEvalGate';

/**
 * ai-assistant-multiagent — rutas de configuración, con supertest sobre use cases REALES.
 *
 * ⚠️ Los use cases NO se mockean (lección #28/#27): los tests de ruta que mockean el use case
 * y los de use case que pegan al repo pueden estar todos verdes con el passthrough del medio
 * ROTO. Acá el viaje va completo: HTTP → Zod → use case real → repo in-memory.
 */

function buildApp(opts: { hasEval?: boolean; canManage?: boolean } = {}) {
  const profiles = new InMemoryAssistantProfileRepository();
  const intents = new InMemoryAssistantIntentRepository();
  const catalog = new InMemoryAssistantCatalogRepository();
  const runs = new InMemoryAssistantRunRepository();
  // Sin `hasEval` explícito el gate consulta el repo REAL de corridas: así el test del seam
  // (registrar eval ⇒ poder habilitar `resolve_conversation`) prueba el circuito completo, no
  // dos mitades que podrían no tocarse. Con `hasEval` se sigue pudiendo forzar el estado.
  const evalGate: AssistantEvalGate = {
    hasRecordedRun: async () => opts.hasEval ?? evals.hasRecordedRun(),
  };
  const provider = new InMemoryAssistantProviderConfigRepository();
  const envCredentials = { baseUrl: 'https://api.deepseek.com', apiKey: '' };
  const routing = new InMemoryAssistantRoutingConfigRepository();
  const evals = new InMemoryAssistantEvalRepository();

  const app = express();
  app.use(express.json());
  app.use(
    '/api/assistant',
    createAssistantRouter({
      createProfile: new CreateAssistantProfile(profiles),
      updateProfile: new UpdateAssistantProfile(profiles, catalog, evalGate),
      getConfig: new GetAssistantConfig(profiles, intents),
      createIntent: new CreateAssistantIntent(profiles, intents, catalog),
      updateIntent: new UpdateAssistantIntent(intents, catalog),
      deleteIntent: new DeleteAssistantIntent(intents),
      listCatalogs: new ListAssistantCatalogs(catalog),
      listRuns: new ListAssistantRuns(runs),
      getProviderConfig: new GetAssistantProviderConfig(provider, envCredentials),
      updateProviderConfig: new UpdateAssistantProviderConfig(provider, envCredentials),
      testConnection: new TestAssistantConnection(
        provider,
        envCredentials,
        () => ({
          classify: async () => ({ kind: 'unavailable' }),
          generate: async () => ({ kind: 'text', text: 'OK' }),
        }),
        'deepseek-chat',
      ),
      recordEvalRun: new RecordAssistantEvalRun(evals),
      listEvalRuns: new ListAssistantEvalRuns(evals),
      setDataSourceEnabled: new SetAssistantDataSourceEnabled(catalog),
      getRoutingConfig: new GetAssistantRoutingConfig(routing),
      updateRoutingConfig: new UpdateAssistantRoutingConfig(routing, profiles),
      auth: (_req, _res, next) => next(),
      requirePerm: (_module, action) => (_req, res, next) => {
        // Simula el guard granular: `manage` se puede denegar para probar las dos capas.
        if (action === 'manage' && opts.canManage === false) {
          res.status(403).json({ error: 'forbidden' });
          return;
        }
        next();
      },
    }),
  );
  app.use(errorHandler);

  return { app, profiles, intents, runs, provider, routing, evals, catalog };
}

describe('GET /api/assistant/catalogs', () => {
  it('devuelve fuentes y acciones envueltas en {data}', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/assistant/catalogs').expect(200);

    expect(res.body.data.dataSources).toHaveLength(4);
    expect(res.body.data.actions).toHaveLength(5);
  });

  it('D2: noc.cortes llega deshabilitada al FE', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/assistant/catalogs');

    const noc = res.body.data.dataSources.find((s: { key: string }) => s.key === 'noc.cortes');
    expect(noc.enabled).toBe(false);
  });
});

describe('POST /api/assistant/profiles', () => {
  it('CFG-1: crea el perfil APAGADO', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .post('/api/assistant/profiles')
      .send({ areaId: 'area-1', persona: 'Cordial' })
      .expect(201);

    expect(res.body.data.enabled).toBe(false);
    expect(res.body.data.enabledActions).toEqual([]);
  });

  it('CFG-1: área duplicada ⇒ 409', async () => {
    const { app } = buildApp();
    await request(app).post('/api/assistant/profiles').send({ areaId: 'area-1' });

    await request(app).post('/api/assistant/profiles').send({ areaId: 'area-1' }).expect(409);
  });

  it('Zod: areaId vacío ⇒ 400', async () => {
    const { app } = buildApp();

    await request(app).post('/api/assistant/profiles').send({ areaId: '' }).expect(400);
  });

  it('RBAC: sin permiso manage ⇒ 403', async () => {
    const { app } = buildApp({ canManage: false });

    await request(app).post('/api/assistant/profiles').send({ areaId: 'area-1' }).expect(403);
  });
});

describe('GET /api/assistant/profiles/by-area/:areaId', () => {
  it('área SIN perfil ⇒ 200 con data:null (NO 404)', async () => {
    // Que un área no tenga agente es el estado NORMAL de casi todas. Un 404 obligaría al FE
    // a tratar lo esperable como error.
    const { app } = buildApp();

    const res = await request(app).get('/api/assistant/profiles/by-area/area-9').expect(200);

    expect(res.body.data).toBeNull();
  });

  it('área CON perfil devuelve el perfil y sus intenciones', async () => {
    const { app } = buildApp();
    const created = await request(app).post('/api/assistant/profiles').send({ areaId: 'area-1' });
    await request(app)
      .post(`/api/assistant/profiles/${created.body.data.id}/intents`)
      .send({ name: 'saldo', description: 'cuánto debe', actionKey: 'whatsapp_reply' });

    const res = await request(app).get('/api/assistant/profiles/by-area/area-1').expect(200);

    expect(res.body.data.intents).toHaveLength(1);
  });
});

describe('POST /api/assistant/profiles/:id/intents — CFG-2 y CFG-3', () => {
  const setup = async () => {
    const ctx = buildApp();
    const res = await request(ctx.app).post('/api/assistant/profiles').send({ areaId: 'area-1' });
    return { ...ctx, profileId: res.body.data.id as string };
  };

  it('CFG-2: crea la intención sin deploy', async () => {
    const { app, profileId } = await setup();

    const res = await request(app)
      .post(`/api/assistant/profiles/${profileId}/intents`)
      .send({
        name: 'estado de cuenta',
        description: 'el cliente pregunta cuánto debe',
        dataSourceKeys: ['cliente.saldo'],
        actionKey: 'whatsapp_reply',
      })
      .expect(201);

    expect(res.body.data.name).toBe('estado de cuenta');
    expect(res.body.data.enabled).toBe(true);
  });

  it('CFG-3: dataSourceKey inventada ⇒ 400, y NO persiste', async () => {
    const { app, profileId } = await setup();

    await request(app)
      .post(`/api/assistant/profiles/${profileId}/intents`)
      .send({
        name: 'x',
        description: 'y',
        dataSourceKeys: ['cliente.tarjeta'],
        actionKey: 'whatsapp_reply',
      })
      .expect(400);

    const check = await request(app).get(`/api/assistant/profiles/${profileId}`);
    expect(check.body.data.intents).toHaveLength(0);
  });

  it('CFG-3: actionKey inventada ⇒ 400', async () => {
    const { app, profileId } = await setup();

    await request(app)
      .post(`/api/assistant/profiles/${profileId}/intents`)
      .send({ name: 'x', description: 'y', actionKey: 'volar_el_router' })
      .expect(400);
  });

  it('CFG-2: nombre duplicado en el mismo perfil ⇒ 409', async () => {
    const { app, profileId } = await setup();
    const body = { name: 'saldo', description: 'y', actionKey: 'whatsapp_reply' };
    await request(app).post(`/api/assistant/profiles/${profileId}/intents`).send(body);

    await request(app).post(`/api/assistant/profiles/${profileId}/intents`).send(body).expect(409);
  });

  it('perfil inexistente ⇒ 404', async () => {
    const { app } = buildApp();

    await request(app)
      .post('/api/assistant/profiles/no-existe/intents')
      .send({ name: 'x', description: 'y', actionKey: 'whatsapp_reply' })
      .expect(404);
  });
});

// ── EVAL-2: el candado de las acciones de riesgo, atravesando la ruta ───────
describe('PATCH /api/assistant/profiles/:id — EVAL-2', () => {
  const setup = async (hasEval: boolean) => {
    const ctx = buildApp({ hasEval });
    const res = await request(ctx.app).post('/api/assistant/profiles').send({ areaId: 'area-1' });
    return { ...ctx, profileId: res.body.data.id as string };
  };

  it('habilitar resolve_conversation SIN eval ⇒ 409', async () => {
    const { app, profileId } = await setup(false);

    await request(app)
      .patch(`/api/assistant/profiles/${profileId}`)
      .send({ enabledActions: ['resolve_conversation'] })
      .expect(409);
  });

  it('las acciones green/yellow no necesitan eval', async () => {
    const { app, profileId } = await setup(false);

    const res = await request(app)
      .patch(`/api/assistant/profiles/${profileId}`)
      .send({ enabledActions: ['private_note', 'whatsapp_reply'] })
      .expect(200);

    expect(res.body.data.enabledActions).toHaveLength(2);
  });

  it('CON eval registrado, la acción red se habilita', async () => {
    const { app, profileId } = await setup(true);

    await request(app)
      .patch(`/api/assistant/profiles/${profileId}`)
      .send({ enabledActions: ['resolve_conversation'] })
      .expect(200);
  });
});

describe('GET /api/assistant/runs — OBS-1', () => {
  it('devuelve el historial vacío sin romperse', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/assistant/runs').expect(200);

    expect(res.body.data).toEqual({ items: [], total: 0 });
  });

  it('filtra por outcome — la métrica que importa es rejected_numbers', async () => {
    const { app, runs } = buildApp();
    await runs.record({
      profileId: 'p1',
      areaId: 'area-1',
      subjectType: 'conversation',
      subjectId: 'conv-1',
      intentName: 'saldo',
      dataSources: ['cliente.saldo'],
      actionKey: 'whatsapp_reply',
      outcome: 'rejected_numbers',
      reason: 'number_not_in_facts',
      latencyMs: 900,
    });

    const res = await request(app)
      .get('/api/assistant/runs?outcome=rejected_numbers')
      .expect(200);

    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].reason).toBe('number_not_in_facts');
  });

  it('un outcome inventado ⇒ 400 (enum cerrado)', async () => {
    const { app } = buildApp();

    await request(app).get('/api/assistant/runs?outcome=inventado').expect(400);
  });

  it('OBS-1: el DTO NO expone profileId ni contenido', async () => {
    const { app, runs } = buildApp();
    await runs.record({
      profileId: 'p1',
      areaId: 'area-1',
      subjectType: 'conversation',
      subjectId: 'conv-1',
      intentName: 'saldo',
      dataSources: [],
      actionKey: null,
      outcome: 'handoff',
      reason: 'out_of_scope',
      latencyMs: null,
    });

    const res = await request(app).get('/api/assistant/runs');

    expect(res.body.data.items[0].profileId).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('p1');
  });
});

describe('/api/assistant/provider — la API key NUNCA baja al navegador', () => {
  it('GET sin credencial cargada avisa que no hay ninguna', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/assistant/provider').expect(200);

    expect(res.body.data.hasApiKey).toBe(false);
    expect(res.body.data.source).toBe('none');
  });

  it('tras guardar una key, el GET devuelve MÁSCARA, jamás la key', async () => {
    const { app } = buildApp();
    await request(app)
      .put('/api/assistant/provider')
      .send({ apiKey: 'sk-super-secreta-9876' })
      .expect(200);

    const res = await request(app).get('/api/assistant/provider').expect(200);

    // La prueba dura: el body COMPLETO no contiene la key.
    expect(JSON.stringify(res.body)).not.toContain('sk-super-secreta-9876');
    expect(res.body.data.apiKeyLast4).toBe('9876');
    expect(res.body.data.source).toBe('db');
  });

  it('ni siquiera el response del PUT repite la key que acabás de mandar', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .put('/api/assistant/provider')
      .send({ apiKey: 'sk-super-secreta-9876' })
      .expect(200);

    expect(JSON.stringify(res.body)).not.toContain('sk-super-secreta-9876');
  });

  it('editar la baseUrl NO borra la key guardada', async () => {
    const { app } = buildApp();
    await request(app).put('/api/assistant/provider').send({ apiKey: 'sk-guardada-4321' });

    await request(app)
      .put('/api/assistant/provider')
      .send({ baseUrl: 'https://otro.host' })
      .expect(200);

    const res = await request(app).get('/api/assistant/provider');
    expect(res.body.data.apiKeyLast4).toBe('4321');
  });

  it('borrar la key requiere clearApiKey explícito', async () => {
    const { app } = buildApp();
    await request(app).put('/api/assistant/provider').send({ apiKey: 'sk-guardada-4321' });

    await request(app).put('/api/assistant/provider').send({ clearApiKey: true }).expect(200);

    const res = await request(app).get('/api/assistant/provider');
    expect(res.body.data.hasApiKey).toBe(false);
  });

  it('una baseUrl inválida ⇒ 400', async () => {
    const { app } = buildApp();

    await request(app).put('/api/assistant/provider').send({ baseUrl: 'no-es-url' }).expect(400);
  });

  it('RBAC: guardar credenciales exige assistant.manage', async () => {
    const { app } = buildApp({ canManage: false });

    await request(app).put('/api/assistant/provider').send({ apiKey: 'sk-x' }).expect(403);
  });
});

describe('/api/assistant/provider/test — la prueba corre en el servidor', () => {
  it('sin credencial responde 200 con ok:false y un mensaje accionable', async () => {
    // 200 y no 5xx: el fallo es el RESULTADO de la prueba, no un error del request.
    const { app } = buildApp();

    const res = await request(app).post('/api/assistant/provider/test').expect(200);

    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.detail).toMatch(/API key/);
  });

  it('con credencial cargada, prueba y responde ok', async () => {
    const { app } = buildApp();
    await request(app).put('/api/assistant/provider').send({ apiKey: 'sk-valida-1111' });

    const res = await request(app).post('/api/assistant/provider/test').expect(200);

    expect(res.body.data.ok).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('sk-valida-1111');
  });

  it('RBAC: probar exige assistant.manage', async () => {
    const { app } = buildApp({ canManage: false });

    await request(app).post('/api/assistant/provider/test').expect(403);
  });
});

/**
 * RTR-0 — la perilla del ruteo, por HTTP y con use cases REALES.
 *
 * Sin estos endpoints `defaultAreaId` no se puede escribir por ningún lado, y el motor hace
 * no-op en TODAS las conversaciones. La feature estuvo en producción, verde y muerta.
 */
describe('GET /api/assistant/routing', () => {
  it('sin configurar: nadie atiende lo que entra sin área', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/assistant/routing').expect(200);

    expect(res.body.data).toEqual({ defaultAreaId: null, rerouteEnabled: false });
  });

  it('devuelve lo guardado', async () => {
    const { app, profiles } = buildApp();
    await profiles.create({ areaId: 'area-soporte' });
    await request(app)
      .put('/api/assistant/routing')
      .send({ defaultAreaId: 'area-soporte', rerouteEnabled: true })
      .expect(200);

    const res = await request(app).get('/api/assistant/routing').expect(200);

    expect(res.body.data).toEqual({ defaultAreaId: 'area-soporte', rerouteEnabled: true });
  });
});

describe('PUT /api/assistant/routing', () => {
  it('apuntar a un área CON agente la deja como default', async () => {
    const { app, profiles, routing } = buildApp();
    await profiles.create({ areaId: 'area-soporte' });

    await request(app)
      .put('/api/assistant/routing')
      .send({ defaultAreaId: 'area-soporte', rerouteEnabled: false })
      .expect(200);

    // El viaje completo: HTTP → zod → use case → repo. Sin esto el passthrough puede estar roto.
    expect(await routing.get()).toMatchObject({ defaultAreaId: 'area-soporte' });
  });

  it('apuntar a un área SIN agente devuelve 400 accionable, no un 500', async () => {
    const { app, routing } = buildApp();

    const res = await request(app)
      .put('/api/assistant/routing')
      .send({ defaultAreaId: 'area-fantasma', rerouteEnabled: false })
      .expect(400);

    expect(res.body.code).toBe('ASSISTANT_DEFAULT_AREA_WITHOUT_AGENT');
    expect(res.body.error).toMatch(/area-fantasma/);
    // Y sobre todo: NO se guardó nada a medias.
    expect(await routing.get()).toMatchObject({ defaultAreaId: null });
  });

  it('apagar el ruteo (null) siempre se puede', async () => {
    const { app, profiles } = buildApp();
    await profiles.create({ areaId: 'area-soporte' });
    await request(app)
      .put('/api/assistant/routing')
      .send({ defaultAreaId: 'area-soporte', rerouteEnabled: true })
      .expect(200);

    const res = await request(app)
      .put('/api/assistant/routing')
      .send({ defaultAreaId: null, rerouteEnabled: false })
      .expect(200);

    expect(res.body.data.defaultAreaId).toBeNull();
  });

  it('un body inválido es 400 (safeParse), NUNCA un 500', async () => {
    const { app } = buildApp();

    await request(app)
      .put('/api/assistant/routing')
      .send({ defaultAreaId: 123, rerouteEnabled: 'sí' })
      .expect(400);
  });

  it('rerouteEnabled es obligatorio: no se infiere un default silencioso', async () => {
    const { app, profiles } = buildApp();
    await profiles.create({ areaId: 'area-soporte' });

    await request(app)
      .put('/api/assistant/routing')
      .send({ defaultAreaId: 'area-soporte' })
      .expect(400);
  });

  it('leer NO requiere manage, pero escribir SÍ', async () => {
    const { app } = buildApp({ canManage: false });

    await request(app).get('/api/assistant/routing').expect(200);
    await request(app)
      .put('/api/assistant/routing')
      .send({ defaultAreaId: null, rerouteEnabled: false })
      .expect(403);
  });
});

/**
 * EVAL-1/EVAL-2 — el candado de `resolve_conversation`, por HTTP.
 *
 * El use case de registro EXISTÍA pero huérfano: ninguna ruta lo llamaba, así que la acción
 * roja no se podía destrabar por ningún camino. Estos tests cierran ese seam.
 */
const VALID_EVAL = {
  model: 'deepseek-chat',
  resolutionTotal: 80,
  resolutionCorrect: 68,
  abstentionTotal: 20,
  abstentionCorrect: 18,
  notes: '100 conversaciones reales',
};

describe('POST /api/assistant/evals', () => {
  it('una corrida válida se registra con sus tasas derivadas', async () => {
    const { app, evals } = buildApp();

    const res = await request(app).post('/api/assistant/evals').send(VALID_EVAL).expect(201);

    expect(res.body.data.abstentionRate).toBeCloseTo(0.9);
    expect(await evals.hasAnyRun()).toBe(true);
  });

  it('sin partición de abstención devuelve 422 (bien formado pero inválido), NO 500', async () => {
    // El corazón del candado: un eval que sólo mide resolución destrabaría la acción roja con
    // un número que no dice nada sobre si el bot sabe callarse.
    //
    // 422 y no 400 a propósito, y el repo ya lo tenía mapeado así: el body está bien FORMADO
    // (zod pasa), lo que falla es la regla de dominio. Esa distinción le dice al FE si el
    // problema es cómo mandó los datos o qué datos mandó.
    const { app, evals } = buildApp();

    const res = await request(app)
      .post('/api/assistant/evals')
      .send({ ...VALID_EVAL, abstentionTotal: 0, abstentionCorrect: 0 })
      .expect(422);

    expect(res.body.code).toBe('INVALID_ASSISTANT_EVAL_RUN');
    expect(await evals.hasAnyRun()).toBe(false);
  });

  it('un body con tipos mal es 400 por zod, nunca un 500', async () => {
    const { app } = buildApp();

    await request(app)
      .post('/api/assistant/evals')
      .send({ model: 123, resolutionTotal: 'ochenta' })
      .expect(400);
  });

  it('registrar exige manage', async () => {
    const { app } = buildApp({ canManage: false });

    await request(app).post('/api/assistant/evals').send(VALID_EVAL).expect(403);
  });

  it('registrar DESTRABA de verdad la acción roja (seam completo con el gate)', async () => {
    // Lo que importa no es que el POST responda 201, sino que DESPUÉS se pueda habilitar
    // `resolve_conversation`. Antes de esta ruta, ese rechazo era permanente.
    const { app } = buildApp();
    const created = await request(app)
      .post('/api/assistant/profiles')
      .send({ areaId: 'area-1' })
      .expect(201);
    const id = created.body.data.id;

    // 409: no es un pedido mal armado, es un conflicto con el estado actual (no hay eval).
    await request(app)
      .patch(`/api/assistant/profiles/${id}`)
      .send({ enabledActions: ['resolve_conversation'] })
      .expect(409);

    await request(app).post('/api/assistant/evals').send(VALID_EVAL).expect(201);

    await request(app)
      .patch(`/api/assistant/profiles/${id}`)
      .send({ enabledActions: ['resolve_conversation'] })
      .expect(200);
  });
});

describe('GET /api/assistant/evals', () => {
  it('sin corridas devuelve lista vacía', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/api/assistant/evals').expect(200);

    expect(res.body.data).toEqual([]);
  });

  it('lo registrado se puede auditar después — un candado invisible es un trámite', async () => {
    const { app } = buildApp();
    await request(app)
      .post('/api/assistant/evals')
      .send({ ...VALID_EVAL, notes: 'muestra de julio' })
      .expect(201);

    const res = await request(app).get('/api/assistant/evals').expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].notes).toBe('muestra de julio');
  });

  it('leer NO requiere manage', async () => {
    const { app } = buildApp({ canManage: false });

    await request(app).get('/api/assistant/evals').expect(200);
  });
});

describe('PATCH /api/assistant/catalogs/data-sources/:key', () => {
  it('prende noc.cortes — el tilde que el seed prometía y no existía', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .patch('/api/assistant/catalogs/data-sources/noc.cortes')
      .send({ enabled: true })
      .expect(200);

    expect(res.body.data.enabled).toBe(true);

    // Y se ve reflejado en el catálogo que consume el FE.
    const catalogs = await request(app).get('/api/assistant/catalogs').expect(200);
    const source = catalogs.body.data.dataSources.find(
      (s: { key: string }) => s.key === 'noc.cortes',
    );
    expect(source.enabled).toBe(true);
  });

  it('se puede volver a apagar', async () => {
    const { app } = buildApp();

    await request(app)
      .patch('/api/assistant/catalogs/data-sources/cliente.saldo')
      .send({ enabled: false })
      .expect(200);

    const catalogs = await request(app).get('/api/assistant/catalogs');
    const source = catalogs.body.data.dataSources.find(
      (s: { key: string }) => s.key === 'cliente.saldo',
    );
    expect(source.enabled).toBe(false);
  });

  it('una key desconocida es 400 nombrando la key, no un 500', async () => {
    const { app } = buildApp();

    const res = await request(app)
      .patch('/api/assistant/catalogs/data-sources/cliente.inventada')
      .send({ enabled: true })
      .expect(400);

    expect(res.body.error).toMatch(/cliente\.inventada/);
  });

  it('NO se puede crear una fuente nueva por esta vía (frontera R5)', async () => {
    const { app } = buildApp();

    await request(app)
      .patch('/api/assistant/catalogs/data-sources/cliente.tarjeta')
      .send({ enabled: true })
      .expect(400);

    const catalogs = await request(app).get('/api/assistant/catalogs');
    expect(catalogs.body.data.dataSources).toHaveLength(4);
  });

  it('togglear exige manage', async () => {
    const { app } = buildApp({ canManage: false });

    await request(app)
      .patch('/api/assistant/catalogs/data-sources/noc.cortes')
      .send({ enabled: true })
      .expect(403);
  });
});
