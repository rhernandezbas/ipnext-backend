import { readFileSync } from 'fs';
import { join } from 'path';
import type { ComposeAssistantEngineDeps } from '../../infrastructure/http/composeAssistantEngine';

/**
 * ai-assistant-multiagent (T6.3) — composition-root test.
 *
 * ⚠️ **Por qué existe.** En la Wave 6 del EPIC #38 las rutas quedaron cableadas pero el hook
 * nunca se inyectó en `app.ts`: los params eran opcionales, los tests inyectan su propio
 * wiring, y el resultado fue **CI verde con la feature MUERTA en producción**. Ningún test de
 * unidad ni de ruta puede cazar eso — el único que puede es uno que mire el composition root.
 *
 * Estas assertions son estáticas sobre el TEXTO del fuente a propósito: importar `app.ts`
 * levantaría media aplicación (Prisma, schedulers, adapters HTTP) y el test dejaría de ser
 * barato y determinístico. Es feo y es el precio correcto.
 *
 * Si un refactor mueve estas líneas, este test debe ACTUALIZARSE, nunca borrarse: el día que
 * se borre, el próximo hook huérfano llega a prod sin que nadie se entere.
 */

const APP_SOURCE = readFileSync(
  join(__dirname, '../../infrastructure/http/app.ts'),
  'utf-8',
);

const ENGINE_SOURCE = readFileSync(
  join(__dirname, '../../infrastructure/http/composeAssistantEngine.ts'),
  'utf-8',
);

describe('composition root — configuración del asistente', () => {
  it('el router de config está MONTADO en /api/assistant', () => {
    expect(APP_SOURCE).toMatch(/app\.use\(\s*['"]\/api\/assistant['"]\s*,\s*composeAssistantModule/);
  });

  it('composeAssistantModule está importado', () => {
    expect(APP_SOURCE).toContain("from './composeAssistantModule'");
  });
});

describe('composition root — MOTOR del asistente (el bug W6)', () => {
  it('el motor se CONSTRUYE en app.ts', () => {
    expect(APP_SOURCE).toMatch(/const\s+assistantEngine\s*=\s*composeAssistantEngine\(/);
  });

  it('el motor se INYECTA en ReceiveChatwootWebhook — sin esto la feature está muerta', () => {
    // El corazón del test: el motor puede existir, compilar y tener 200 tests verdes, y no
    // servir para nada si nadie lo llama.
    const construction = APP_SOURCE.match(/new ReceiveChatwootWebhook\(([^)]*)\)/);

    expect(construction).not.toBeNull();
    expect(construction?.[1]).toContain('assistantEngine');
  });

  it('el motor recibe el lector de hilo y el resolver de cliente', () => {
    expect(APP_SOURCE).toContain('new ChatMessageThreadReader(');
    expect(APP_SOURCE).toContain('new CustomerAssistantClientResolver(');
  });
});

describe('composition root — resolvers de datos registrados', () => {
  it('registra exactamente los 3 resolvers implementados', () => {
    for (const resolver of [
      'ClienteSaldoResolver',
      'ClienteServicioResolver',
      'OsAbiertasResolver',
    ]) {
      expect(ENGINE_SOURCE).toContain(`new ${resolver}(`);
    }
  });

  it('NO registra un resolver para noc.cortes', () => {
    // Deliberado (design D2): no existe mapeo confiable cliente→zona→alerta, y un resolver
    // que adivinara respondería "no hay cortes" sin respaldo — el modo de falla que este
    // change combate. El catálogo la tiene deshabilitada; las dos capas coinciden.
    expect(ENGINE_SOURCE).not.toMatch(/NocCortes\w*Resolver/);
  });

  it('el adapter de DeepSeek se cablea con la config, no con literales', () => {
    expect(ENGINE_SOURCE).toContain('new HttpDeepSeekAssistant(');
    expect(ENGINE_SOURCE).toContain('config.assistant.apiKey');
  });

  it('la salida va por los use cases de siempre (RUN-3), no por un camino propio', () => {
    expect(ENGINE_SOURCE).toContain('ChatwootAssistantConversationGateway');
    expect(ENGINE_SOURCE).toContain('deps.sendMessage');
    expect(ENGINE_SOURCE).toContain('deps.setConversationArea');
  });
});

describe('composition root — arranca en modo oscuro', () => {
  it('el flag global se llama ai-assistant-enabled y la migración lo siembra en false', () => {
    const migration = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261023000000_ai_assistant_multiagent/migration.sql',
      ),
      'utf-8',
    );

    expect(migration).toMatch(/VALUES\s*\(\s*'ai-assistant-enabled'\s*,\s*false/);
  });

  it('el ruteo arranca SIN área default — nadie atiende hasta que se configure', () => {
    const migration = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261023000000_ai_assistant_multiagent/migration.sql',
      ),
      'utf-8',
    );

    expect(migration).toMatch(/INSERT INTO "AssistantRoutingConfig"[\s\S]*?NULL/);
  });

  it('ninguna acción de riesgo viene habilitada (enabledActions nace vacío)', () => {
    const schema = readFileSync(join(__dirname, '../../../prisma/schema.prisma'), 'utf-8');

    expect(schema).toMatch(/enabledActions\s+String\[\]\s+@default\(\[\]\)/);
  });
});

/**
 * customer-balance-unmask (Fase 4, tareas 4.9/4.10) — spec assistant-balance-guard,
 * requirement "refreshBalance is wired at the composition root".
 *
 * ⚠️ **P1 es el pin que de verdad discrimina.** El resto de este archivo es
 * assertion ESTÁTICA sobre el TEXTO de `app.ts`/`composeAssistantEngine.ts` —
 * barato pero engañable por un `if (false)`, un comentario, o un wiring inline
 * disfrazado. `app.ts:3267-3277` YA construye `assistantEngine` textualmente
 * (`composeAssistantEngine({...})` matchea el regex de la línea 42 arriba) —
 * ese test NUNCA detectó que faltaba `refreshBalance` en el objeto.
 *
 * P1 bootea `createApp()` DE VERDAD (molde `messaging-composition.test.ts:298-372`
 * — Prisma/pg conectan lazy, no hace falta Postgres viva) con
 * `jest.doMock('./composeAssistantEngine')` capturando el objeto `deps` REAL con
 * el que `app.ts` invoca la función — no hay forma de satisfacer esto con texto.
 *
 * Control obligatorio (P1, sin env de GR ⇒ `undefined`): sin esto el pin no
 * discrimina — lección "probe-de-ausencia-no-discrimina" en espejo (acá al
 * revés: probar la AUSENCIA de la dep cuando GR no está configurado, para
 * confirmar que el `undefined` es real y no que el mock nunca capturó nada).
 */
describe('composition root — P1: boot REAL de createApp() captura deps.refreshBalance (M-C revert-probe target)', () => {
  const ORIGINAL_ENV = process.env;
  const ENGINE_MODULE_PATH = '../../infrastructure/http/composeAssistantEngine';

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.dontMock(ENGINE_MODULE_PATH);
    jest.resetModules();
  });

  it('P1 — con GR_SYNC_ENABLED/GR_CUIT/GR_SECRET seteados, deps.refreshBalance es instancia de RefreshClientBalanceIfStale', () => {
    jest.resetModules();
    let capturedDeps: Record<string, unknown> | undefined;
    jest.doMock(ENGINE_MODULE_PATH, () => ({
      composeAssistantEngine: (deps: Record<string, unknown>) => {
        capturedDeps = deps;
        // Stub — nada en el boot síncrono de createApp() invoca al motor devuelto.
        return {};
      },
    }));
    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
      GR_SYNC_ENABLED: 'true',
      GR_CUIT: '30-12345678-9',
      GR_SECRET: 'a-secret',
    };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp } = require('../../infrastructure/http/app');
    createApp();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RefreshClientBalanceIfStale } = require('../../application/use-cases/RefreshClientBalanceIfStale');
    expect(capturedDeps).toBeDefined();
    expect(capturedDeps?.refreshBalance).toBeInstanceOf(RefreshClientBalanceIfStale);
  });

  it('P1 control — SIN env de GR, deps.refreshBalance es undefined (sin este control el pin de arriba no discrimina)', () => {
    jest.resetModules();
    let capturedDeps: Record<string, unknown> | undefined;
    jest.doMock(ENGINE_MODULE_PATH, () => ({
      composeAssistantEngine: (deps: Record<string, unknown>) => {
        capturedDeps = deps;
        return {};
      },
    }));
    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
    };
    delete process.env.GR_SYNC_ENABLED;
    delete process.env.GR_CUIT;
    delete process.env.GR_SECRET;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp } = require('../../infrastructure/http/app');
    createApp();

    expect(capturedDeps).toBeDefined();
    expect(capturedDeps?.refreshBalance).toBeUndefined();
  });

  /**
   * fix wave F6(a) — **el `withTimeout` del use case no aborta el axios.**
   *
   * `RefreshClientBalanceIfStale.withTimeout` hace `Promise.race`: cuando vence,
   * el caller sigue de largo pero la request a GR **sigue viva**, y detrás
   * `postWithRetry` reintenta hasta 3 veces con backoff exponencial. Un solo
   * mensaje de WhatsApp podía dejar ~16s de llamadas huérfanas a GR — trabajo
   * que ya no le importa a nadie, contra un proveedor cuyo load balancer
   * justamente se cae bajo carga.
   *
   * El wrapper YA es el techo de tiempo. Reintentar por detrás no aporta nada
   * que el caller pueda usar: cuando la respuesta llegue, el WhatsApp ya se
   * contestó. Instancia dedicada con `maxRetries: 0`.
   */
  it('F6a — el GestionRealClient del REFRESH va con maxRetries 0 (el withTimeout ya es el techo; reintentar por detrás son llamadas huérfanas)', () => {
    jest.resetModules();
    let capturedDeps: Record<string, unknown> | undefined;
    jest.doMock(ENGINE_MODULE_PATH, () => ({
      composeAssistantEngine: (deps: Record<string, unknown>) => {
        capturedDeps = deps;
        return {};
      },
    }));
    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
      GR_SYNC_ENABLED: 'true',
      GR_CUIT: '30-12345678-9',
      GR_SECRET: 'a-secret',
      BALANCE_REFRESH_TIMEOUT_MS: '3000',
    };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp } = require('../../infrastructure/http/app');
    createApp();

    // Se inspecciona la INSTANCIA realmente cableada, no el texto de app.ts:
    // un pin de texto lo satisface cualquier `maxRetries: 0` en un cliente
    // que después no se usa.
    const refresh = capturedDeps?.refreshBalance as { gr: { maxRetries: number; http: { defaults: { timeout: number } } } };
    expect(refresh).toBeDefined();
    expect(refresh.gr.maxRetries).toBe(0);
    // Y el timeout del axios es el del refresh (clampeado), no el general.
    expect(refresh.gr.http.defaults.timeout).toBe(3000);
  });
});

/**
 * fix wave F9 — **P1 pineaba la CLASE, no la IDENTIDAD.**
 *
 * El mutante M11b sobrevivió los 16 tests: construir una instancia PARALELA de
 * `RefreshClientBalanceIfStale` (misma clase, GR stub roto) sólo para el bot
 * pasaba P1, P2 y el control — `toBeInstanceOf` no distingue "la misma" de "una
 * igual". Y el comentario de `app.ts` afirma explícitamente que es LA MISMA
 * instancia que ya usan la ficha y el inbox.
 *
 * Post-F2 eso dejó de ser un detalle de prolijidad y pasó a ser funcional: el
 * single-flight vive en un mapa de INSTANCIA. Tres instancias distintas ⇒ tres
 * vuelos concurrentes al mismo cliente ⇒ vuelve la carrera que F2 cerró. La
 * identidad es ahora parte del contrato, y esto es lo que la pinea.
 */
describe('composition root — F9: ficha, inbox y bot comparten LA MISMA instancia de RefreshClientBalanceIfStale', () => {
  const ORIGINAL_ENV = process.env;
  const ENGINE_MODULE_PATH = '../../infrastructure/http/composeAssistantEngine';
  const DETAIL_MODULE_PATH = '../../application/use-cases/GetClientDetail';
  const INBOX_MODULE_PATH = '../../application/use-cases/messaging/GetInboxClientContext';

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.dontMock(ENGINE_MODULE_PATH);
    jest.dontMock(DETAIL_MODULE_PATH);
    jest.dontMock(INBOX_MODULE_PATH);
    jest.resetModules();
  });

  it('F9 — las tres superficies reciben la MISMA instancia (toBe, no toBeInstanceOf)', () => {
    jest.resetModules();
    let botRefresh: unknown;
    let detailRefresh: unknown;
    let inboxRefresh: unknown;

    jest.doMock(ENGINE_MODULE_PATH, () => ({
      composeAssistantEngine: (deps: Record<string, unknown>) => {
        botRefresh = deps.refreshBalance;
        return {};
      },
    }));
    // Los dos use cases se capturan por su POSICIÓN en el constructor — que es
    // exactamente el contrato que app.ts tiene que respetar.
    jest.doMock(DETAIL_MODULE_PATH, () => ({
      GetClientDetail: class {
        constructor(_repo: unknown, refresh: unknown) {
          detailRefresh = refresh;
        }
      },
    }));
    jest.doMock(INBOX_MODULE_PATH, () => ({
      GetInboxClientContext: class {
        constructor(...args: unknown[]) {
          inboxRefresh = args[10]; // 11º arg — ver el wiring de app.ts
        }
      },
    }));

    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
      GR_SYNC_ENABLED: 'true',
      GR_CUIT: '30-12345678-9',
      GR_SECRET: 'a-secret',
    };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp } = require('../../infrastructure/http/app');
    createApp();

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RefreshClientBalanceIfStale } = require('../../application/use-cases/RefreshClientBalanceIfStale');
    expect(botRefresh).toBeInstanceOf(RefreshClientBalanceIfStale);
    // ⚠️ EL PIN: identidad, no tipo. Esto es lo que mata a M11b.
    expect(detailRefresh).toBe(botRefresh);
    expect(inboxRefresh).toBe(botRefresh);
  });
});

/**
 * customer-balance-unmask (Fase 4, tarea 4.11) — P2: `composeAssistantEngine`
 * (SIN mockear, la función real) le pasa `deps.refreshBalance` como 2º arg al
 * constructor de `ClienteSaldoResolver`. Complementa a P1 (que prueba que
 * `app.ts` LE DA la dep a la función) verificando que la función HACE algo
 * con ella — cierra el camino completo `app.ts` → `composeAssistantEngine` →
 * `ClienteSaldoResolver`.
 */
describe('composeAssistantEngine — P2: refreshBalance llega al constructor de ClienteSaldoResolver', () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.dontMock('../../infrastructure/adapters/assistant/ClienteSaldoResolver');
    jest.resetModules();
  });

  it('el 2º arg del constructor de ClienteSaldoResolver es deps.refreshBalance', () => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
    };
    const ctorSpy = jest.fn();
    jest.doMock('../../infrastructure/adapters/assistant/ClienteSaldoResolver', () => ({
      ClienteSaldoResolver: class {
        readonly key = 'cliente.saldo';
        constructor(...args: unknown[]) {
          ctorSpy(...args);
        }
        async resolve() {
          return {};
        }
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { composeAssistantEngine } = require('../../infrastructure/http/composeAssistantEngine');
    const fakeRefreshBalance = { execute: jest.fn() };
    const deps = {
      conversationRepo: {},
      customerRepo: { marker: 'customerRepo' },
      chatwootGateway: {},
      sendMessage: {},
      setConversationArea: {},
      setConversationStatus: {},
      listTasks: {},
      threadReader: {},
      clientResolver: {},
      refreshBalance: fakeRefreshBalance,
    };

    composeAssistantEngine(deps);

    expect(ctorSpy).toHaveBeenCalledWith(deps.customerRepo, fakeRefreshBalance);
  });
});

/**
 * customer-balance-unmask (Fase 4, tarea 4.12) — pin de TIPO (no de texto ni de
 * runtime): `refreshBalance` es aditivo (opcional) — un `ComposeAssistantEngineDeps`
 * sin ese campo sigue compilando — pero si está presente, su tipo debe ser
 * `RefreshClientBalanceIfStale`. Un `@ts-expect-error` que dejara de fallar acá
 * (porque alguien lo tipeó `any`/`unknown`) rompería este test — el compilador
 * es el runner.
 */
describe('composeAssistantEngine — pin de tipos de ComposeAssistantEngineDeps.refreshBalance (aridad, tarea 4.12)', () => {
  it('refreshBalance ausente compila (aditivo); refreshBalance con tipo incorrecto NO compila', () => {
    const baseDeps = {
      conversationRepo: {},
      customerRepo: {},
      chatwootGateway: {},
      sendMessage: {},
      setConversationArea: {},
      setConversationStatus: {},
      listTasks: {},
      threadReader: {},
      clientResolver: {},
    } as unknown as Omit<ComposeAssistantEngineDeps, 'refreshBalance'>;

    // Aditivo: sin `refreshBalance` en absoluto, sigue siendo un ComposeAssistantEngineDeps válido.
    const depsWithoutRefresh: ComposeAssistantEngineDeps = { ...baseDeps };
    expect(depsWithoutRefresh.refreshBalance).toBeUndefined();

    // @ts-expect-error — refreshBalance con tipo incorrecto (string, no RefreshClientBalanceIfStale) NO debe compilar.
    const wrongType: ComposeAssistantEngineDeps = { ...baseDeps, refreshBalance: 'not-a-refresher' };
    expect(typeof wrongType.refreshBalance).toBe('string');
  });
});
