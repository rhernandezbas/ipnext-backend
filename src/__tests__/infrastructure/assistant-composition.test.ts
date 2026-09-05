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
   * contestó. Instancia dedicada, con los reintentos ACOTADOS.
   *
   * ────────────────────────────────────────────────────────────────────────
   * fix wave 2 (FW2-2) — **`maxRetries: 0` era romo.** Medido: un blip simple de
   * GR se recupera en ~694ms con UN reintento, que entra holgado en el budget de
   * 4s del `withTimeout`. Con 0 reintentos ese blip es un handoff instantáneo —
   * y como el vuelo es single-flight, el fallo se COMPARTE con todos los callers
   * que estaban esperando ese mismo cliente.
   *
   * `1` es el punto medio con las dos propiedades: conserva la recuperación del
   * blip simple y acota el huérfano a UNA llamada de más (no 3 con backoff, que
   * era el ~16s del defecto original).
   */
  it('FW2-2 — el GestionRealClient del REFRESH va con maxRetries 1 (recupera el blip simple; el huérfano queda acotado a 1)', () => {
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
    expect(refresh.gr.maxRetries).toBe(1);
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

/**
 * ai-assistant-cobranzas (Lote F 6.1 / Lote G3 6.3) — composición de las fuentes nuevas.
 *
 * ⚠️ **Por qué estos pins son de RUNTIME y no de texto.** Todo el batch anterior
 * (`ClienteFacturasResolver`, `ClienteRecibosHoyResolver`, `PrismaAssistantInvoicesReader`,
 * `fetchClientReceipts`, el `unassign` de dos lados, la lista blanca de `senderName`) está
 * verde en sus tests de unidad y era, hasta acá, **INERTE en producción**: nadie lo registraba
 * ni lo inyectaba. Es exactamente la lección "feature sin perilla = inerte" y el bug W6 otra
 * vez. Un `expect(SOURCE).toContain(...)` lo satisface un comentario; estos tests construyen
 * la composición REAL y miran las instancias que llegan a cada constructor.
 */
describe('composición ai-assistant-cobranzas — fuentes nuevas registradas (6.1 / 6.3)', () => {
  const ORIGINAL_ENV = process.env;
  const REGISTRY_PATH = '../../infrastructure/adapters/assistant/AssistantDataSourceRegistryImpl';
  const SALDO_PATH = '../../infrastructure/adapters/assistant/ClienteSaldoResolver';
  const FACTURAS_PATH = '../../infrastructure/adapters/assistant/ClienteFacturasResolver';
  const RECIBOS_PATH = '../../infrastructure/adapters/assistant/ClienteRecibosHoyResolver';
  const GATEWAY_PATH = '../../infrastructure/adapters/assistant/ChatwootAssistantConversationGateway';

  const baseEnv = {
    SPLYNX_API_URL: 'http://x',
    SPLYNX_API_KEY: 'k',
    SPLYNX_API_SECRET: 's',
    JWT_SECRET: 'j',
    PORT: '3000',
  };

  function fakeDeps(extra: Record<string, unknown> = {}) {
    return {
      conversationRepo: { marker: 'conversationRepo' },
      customerRepo: { marker: 'customerRepo' },
      chatwootGateway: { marker: 'chatwootGateway' },
      sendMessage: { marker: 'sendMessage' },
      setConversationArea: {},
      setConversationStatus: {},
      listTasks: {},
      threadReader: { marker: 'threadReader' },
      clientResolver: {},
      refreshBalance: { execute: jest.fn() },
      ...extra,
    };
  }

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    for (const p of [REGISTRY_PATH, SALDO_PATH, FACTURAS_PATH, RECIBOS_PATH, GATEWAY_PATH]) {
      jest.dontMock(p);
    }
    jest.resetModules();
  });

  it('6.1/6.3 — el registry expone cliente.facturas y cliente.recibos_hoy junto a las 3 fuentes viejas', () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...baseEnv };

    let registered: Array<{ key: string }> = [];
    jest.doMock(REGISTRY_PATH, () => ({
      AssistantDataSourceRegistryImpl: class {
        constructor(resolvers: Array<{ key: string }>) {
          registered = resolvers;
        }
        get() {
          return undefined;
        }
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { composeAssistantEngine } = require('../../infrastructure/http/composeAssistantEngine');
    composeAssistantEngine(fakeDeps({ gestionReal: { fetchClientReceipts: jest.fn() } }));

    expect(registered.map((r) => r.key).sort()).toEqual([
      'cliente.facturas',
      'cliente.recibos_hoy',
      'cliente.saldo',
      'cliente.servicio',
      'os.abiertas',
    ]);
  });

  it('6.1 (pin D8) — ClienteFacturasResolver recibe LA MISMA instancia de refreshBalance que cliente.saldo, y un PrismaAssistantInvoicesReader real', () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...baseEnv };

    const saldoSpy = jest.fn();
    const facturasSpy = jest.fn();
    jest.doMock(SALDO_PATH, () => ({
      ClienteSaldoResolver: class {
        readonly key = 'cliente.saldo';
        constructor(...args: unknown[]) {
          saldoSpy(...args);
        }
        async resolve() {
          return {};
        }
      },
    }));
    jest.doMock(FACTURAS_PATH, () => ({
      ClienteFacturasResolver: class {
        readonly key = 'cliente.facturas';
        constructor(...args: unknown[]) {
          facturasSpy(...args);
        }
        async resolve() {
          return {};
        }
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { composeAssistantEngine } = require('../../infrastructure/http/composeAssistantEngine');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaAssistantInvoicesReader } = require('../../infrastructure/adapters/prisma/PrismaAssistantInvoicesReader');

    const deps = fakeDeps();
    composeAssistantEngine(deps);

    expect(facturasSpy).toHaveBeenCalledTimes(1);
    const [customers, invoices, refresh] = facturasSpy.mock.calls[0];
    expect(customers).toBe(deps.customerRepo);
    expect(invoices).toBeInstanceOf(PrismaAssistantInvoicesReader);
    // ⚠️ EL PIN de D8: identidad, no tipo. Dos instancias de RefreshClientBalanceIfStale ⇒
    // dos vuelos a GR en la misma corrida ⇒ saldo y facturas de payloads distintos.
    expect(refresh).toBe(deps.refreshBalance);
    expect(saldoSpy.mock.calls[0][1]).toBe(refresh);
  });

  it('6.3 — ClienteRecibosHoyResolver recibe el MISMO GestionRealPort y el MISMO threadReader del motor', () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...baseEnv };

    const recibosSpy = jest.fn();
    jest.doMock(RECIBOS_PATH, () => ({
      ClienteRecibosHoyResolver: class {
        readonly key = 'cliente.recibos_hoy';
        constructor(...args: unknown[]) {
          recibosSpy(...args);
        }
        async resolve() {
          return {};
        }
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { composeAssistantEngine } = require('../../infrastructure/http/composeAssistantEngine');
    const gr = { fetchClientReceipts: jest.fn() };
    const deps = fakeDeps({ gestionReal: gr });
    composeAssistantEngine(deps);

    expect(recibosSpy).toHaveBeenCalledTimes(1);
    const [customers, port, thread] = recibosSpy.mock.calls[0];
    expect(customers).toBe(deps.customerRepo);
    expect(port).toBe(gr);
    // El hilo del resolver es el MISMO puerto angosto del motor (SEC-1): un segundo lector
    // con otra config leería el adjunto con otras reglas.
    expect(thread).toBe(deps.threadReader);
  });

  it('6.3 (D9) — sin GestionRealPort, cliente.recibos_hoy NO se registra (mejor ausente que respondiendo "no encontramos tu pago")', () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...baseEnv };

    let registered: Array<{ key: string }> = [];
    jest.doMock(REGISTRY_PATH, () => ({
      AssistantDataSourceRegistryImpl: class {
        constructor(resolvers: Array<{ key: string }>) {
          registered = resolvers;
        }
        get() {
          return undefined;
        }
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { composeAssistantEngine } = require('../../infrastructure/http/composeAssistantEngine');
    composeAssistantEngine(fakeDeps());

    expect(registered.map((r) => r.key)).not.toContain('cliente.recibos_hoy');
    // Control: el resto SÍ está — sin esto el test pasaría con un registry vacío.
    expect(registered.map((r) => r.key)).toContain('cliente.facturas');
  });

  it('6.3 (D10/ACT-4) — el gateway recibe el AssignConversation real, no un stub: unassign espeja los DOS lados', () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...baseEnv };

    const gatewaySpy = jest.fn();
    jest.doMock(GATEWAY_PATH, () => ({
      ChatwootAssistantConversationGateway: class {
        constructor(...args: unknown[]) {
          gatewaySpy(...args);
        }
      },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { composeAssistantEngine } = require('../../infrastructure/http/composeAssistantEngine');
    const assignConversation = { execute: jest.fn() };
    const deps = fakeDeps({ assignConversation });
    composeAssistantEngine(deps);

    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    const args = gatewaySpy.mock.calls[0];
    expect(args[0]).toBe(deps.conversationRepo);
    expect(args[4]).toBe(deps.chatwootGateway);
    // 6º arg — sin esto `unassign` desasigna sólo en Chatwoot y el espejo local queda mintiendo.
    expect(args[5]).toBe(assignConversation);
  });
});

/**
 * ai-assistant-cobranzas (6.2) — boot REAL de `createApp()`: lo que app.ts LE DA al motor.
 * Complementa a los tests de arriba (que prueban qué hace `composeAssistantEngine` con lo que
 * recibe) cerrando el camino entero app.ts → compose → resolvers.
 */
describe('composition root — 6.2: app.ts inyecta gestionReal, assignConversation y la lista blanca de senders', () => {
  const ORIGINAL_ENV = process.env;
  const ENGINE_MODULE_PATH = '../../infrastructure/http/composeAssistantEngine';

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.dontMock(ENGINE_MODULE_PATH);
    jest.resetModules();
  });

  function boot(env: Record<string, string>): Record<string, unknown> | undefined {
    jest.resetModules();
    let capturedDeps: Record<string, unknown> | undefined;
    jest.doMock(ENGINE_MODULE_PATH, () => ({
      composeAssistantEngine: (deps: Record<string, unknown>) => {
        capturedDeps = deps;
        return {};
      },
    }));
    process.env = {
      ...process.env,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
      ...env,
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp } = require('../../infrastructure/http/app');
    createApp();
    return capturedDeps;
  }

  const GR_ENV = {
    GR_SYNC_ENABLED: 'true',
    GR_CUIT: '30-12345678-9',
    GR_SECRET: 'a-secret',
  };

  it('6.2 — con GR configurado, deps.gestionReal es EL MISMO GestionRealClient del refresh (no un segundo cliente)', () => {
    process.env = { ...ORIGINAL_ENV };
    const deps = boot(GR_ENV);
    expect(deps?.gestionReal).toBeDefined();
    // Identidad: el carril del bot ya está afinado (maxRetries 1, timeout del refresh).
    // Un cliente nuevo acá volvería a los 3 reintentos con backoff dentro del camino caliente.
    const refresh = deps?.refreshBalance as { gr: unknown };
    expect(deps?.gestionReal).toBe(refresh.gr);
  });

  it('6.2 control — SIN env de GR, deps.gestionReal es undefined (el pin de arriba no discriminaría sin esto)', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GR_SYNC_ENABLED;
    delete process.env.GR_CUIT;
    delete process.env.GR_SECRET;
    const deps = boot({});
    expect(deps).toBeDefined();
    expect(deps?.gestionReal).toBeUndefined();
  });

  it('6.2 — deps.assignConversation es una instancia REAL de AssignConversation', () => {
    process.env = { ...ORIGINAL_ENV };
    const deps = boot(GR_ENV);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AssignConversation } = require('../../application/use-cases/messaging/AssignConversation');
    expect(deps?.assignConversation).toBeInstanceOf(AssignConversation);
  });

  it('6.2 (SEC-6) — ASSISTANT_SENDER_NAMES llega al ChatMessageThreadReader como lista blanca normalizada', () => {
    process.env = { ...ORIGINAL_ENV };
    const deps = boot({ ...GR_ENV, ASSISTANT_SENDER_NAMES: 'Asistente IPNEXT, Bot IA ' });
    const reader = deps?.threadReader as { assistantSenders: Set<string>; attachments?: unknown };
    expect(reader.assistantSenders).toBeInstanceOf(Set);
    expect([...reader.assistantSenders].sort()).toEqual(['asistente ipnext', 'bot ia']);
    // D11 — sin el espejo de adjuntos, la excepción del comprobante nunca se activa.
    expect(reader.attachments).toBeDefined();
  });

  it('6.2 control (SEC-6) — sin ASSISTANT_SENDER_NAMES la lista queda VACÍA: el lado cauto (todo saliente = humano)', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ASSISTANT_SENDER_NAMES;
    const deps = boot({ ...GR_ENV });
    const reader = deps?.threadReader as { assistantSenders: Set<string> };
    expect(reader.assistantSenders.size).toBe(0);
  });
});
