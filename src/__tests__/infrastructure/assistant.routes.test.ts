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
  const evalGate: AssistantEvalGate = { hasRecordedRun: async () => opts.hasEval ?? false };
  const provider = new InMemoryAssistantProviderConfigRepository();
  const envCredentials = { baseUrl: 'https://api.deepseek.com', apiKey: '' };

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

  return { app, profiles, intents, runs, provider };
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
