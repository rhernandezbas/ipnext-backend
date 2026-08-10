/**
 * customer-balance-unmask (Fase 4, tarea 4.14/4.15) — design.md Decisión 4: el
 * techo de `BALANCE_REFRESH_TIMEOUT_MS` baja de 60.000ms a 10.000ms. Un env de
 * 60s corriendo DENTRO del flujo de un mensaje de WhatsApp (el bot es el primer
 * consumidor que paga ese timeout en el camino caliente) es un cuelgue — lección
 * de la fix wave del portal ("techo del timeout de refresh 10s y no 60"). El
 * default (4000ms) NO cambia — solo el piso de seguridad del clamp.
 *
 * Mismo patrón de aislamiento que config.messagingBulk.test.ts: `config.ts`
 * corre `validateEnv()` como side-effect de import, así que cada caso setea
 * `process.env` y re-importa con `jest.resetModules()`.
 */
describe('config.gestionReal.balanceRefreshTimeoutMs (BALANCE_REFRESH_TIMEOUT_MS)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
    };
    delete process.env.BALANCE_REFRESH_TIMEOUT_MS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('ausente → default 4000 (sin cambio)', () => {
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.balanceRefreshTimeoutMs).toBe(4000);
  });

  it('BALANCE_REFRESH_TIMEOUT_MS=60000 clampea al NUEVO techo 10000 (antes: 60000 pasaba tal cual)', () => {
    process.env.BALANCE_REFRESH_TIMEOUT_MS = '60000';
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.balanceRefreshTimeoutMs).toBe(10000);
  });

  it('BALANCE_REFRESH_TIMEOUT_MS=8000 (dentro del nuevo techo) pasa sin clampear', () => {
    process.env.BALANCE_REFRESH_TIMEOUT_MS = '8000';
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.balanceRefreshTimeoutMs).toBe(8000);
  });

  // fix wave F11(a) — el PISO del clamp también es una decisión, no un adorno.
  // Un `BALANCE_REFRESH_TIMEOUT_MS=1` no es "más rápido": es un timeout que
  // vence antes de que GR pueda contestar NUNCA, o sea el refresh apagado en
  // silencio. La basura cae al valor SEGURO (500), no al default.
  it('F11a — BALANCE_REFRESH_TIMEOUT_MS=1 clampea al PISO 500 (no al default 4000, ni pasa tal cual)', () => {
    process.env.BALANCE_REFRESH_TIMEOUT_MS = '1';
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.balanceRefreshTimeoutMs).toBe(500);
  });
});

/**
 * fix wave F6(b) — **el techo de 10s era del refresh, y se lo comió también el
 * reconcile.**
 *
 * `app.ts` construía UN solo `GestionRealClient` con
 * `timeoutMs: balanceRefreshTimeoutMs` y se lo daba a los dos: al refresh
 * on-demand (camino caliente de un WhatsApp, donde 10s ya es un cuelgue) y a
 * `ReconcileGrClients`, que pagina el universo COMPLETO de GR (~147 páginas) en
 * una ruta de diagnóstico donde nadie está esperando en tiempo real. Bajar el
 * techo por el primero le puso al segundo un timeout de 4s por página.
 *
 * La premisa del comentario que justificaba el clamp era cierta para UNO de los
 * dos consumidores. Ahora cada uno tiene su knob.
 */
describe('config.gestionReal.requestTimeoutMs (GR_REQUEST_TIMEOUT_MS)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...ORIGINAL_ENV,
      SPLYNX_API_URL: 'http://x',
      SPLYNX_API_KEY: 'k',
      SPLYNX_API_SECRET: 's',
      JWT_SECRET: 'j',
      PORT: '3000',
    };
    delete process.env.GR_REQUEST_TIMEOUT_MS;
    delete process.env.BALANCE_REFRESH_TIMEOUT_MS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('F6b — ausente → 30000 (el default del adapter, no el del refresh)', () => {
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.requestTimeoutMs).toBe(30_000);
  });

  it('F6b — es INDEPENDIENTE del refresh: bajar BALANCE_REFRESH_TIMEOUT_MS no toca al reconcile', () => {
    process.env.BALANCE_REFRESH_TIMEOUT_MS = '1000';
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.balanceRefreshTimeoutMs).toBe(1000);
    expect(config.gestionReal.requestTimeoutMs).toBe(30_000);
  });

  it('F6b — su propio techo es HOLGADO (60s): es un diagnóstico, no un camino caliente', () => {
    process.env.GR_REQUEST_TIMEOUT_MS = '900000';
    const { config } = require('../../infrastructure/config');
    expect(config.gestionReal.requestTimeoutMs).toBe(60_000);
  });
});
