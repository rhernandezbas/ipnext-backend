import axios from 'axios';
import { GestionRealClient } from '@infrastructure/adapters/gestion-real/GestionRealClient';

jest.mock('axios');

/**
 * Retry/backoff resilience of GestionRealClient (change gr-client-retry-backoff).
 * The GR load balancer flaps (503 on some nodes, ok on others); a single 503 used
 * to fail the whole sync tick. These tests pin the retry-on-transient behavior.
 *
 * axios is mocked: axios.create() returns { post: postMock } so we drive the HTTP
 * layer directly. sleep/random are injected so tests are deterministic and instant.
 */

/** Minimal responses that the pure parsers tolerate without throwing. */
const CLIENTS_OK = { data: { resultados: '0', clientes: {} } };
const ORDERS_OK = { data: { error: '0' } };

/** Build an AxiosError-like rejection. status omitted ⇒ network/timeout (no response). */
function axiosErr(status?: number, opts: { code?: string; headers?: Record<string, string> } = {}) {
  return {
    isAxiosError: true,
    message: status ? `Request failed with status code ${status}` : 'network error',
    code: opts.code,
    response: status === undefined ? undefined : { status, headers: opts.headers ?? {} },
  };
}

let postMock: jest.Mock;
let sleepSpy: jest.Mock;

function makeClient(overrides: Record<string, unknown> = {}) {
  postMock = jest.fn();
  (axios.create as jest.Mock).mockReturnValue({ post: postMock } as unknown as ReturnType<typeof axios.create>);
  sleepSpy = jest.fn().mockResolvedValue(undefined);
  return new GestionRealClient({
    baseUrl: 'https://gr.test/',
    cuit: '20304050607',
    secret: 'SECRET',
    now: () => new Date('2026-07-11T09:00:00Z'),
    sleep: sleepSpy as unknown as (ms: number) => Promise<void>,
    random: () => 0,
    ...overrides,
  } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GestionRealClient — retry on transient errors', () => {
  it('RETRY-6: éxito al primer intento no reintenta ni duerme', async () => {
    const gr = makeClient();
    postMock.mockResolvedValueOnce(CLIENTS_OK);

    const res = await gr.fetchClients({ cantidad: 100, offset: 0 });

    expect(res.total).toBe(0);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('RETRY-1: 503 y luego 200 → reintenta y devuelve el parseado', async () => {
    const gr = makeClient();
    postMock.mockRejectedValueOnce(axiosErr(503)).mockResolvedValueOnce(CLIENTS_OK);

    const res = await gr.fetchClients({ cantidad: 100, offset: 0 });

    expect(res.total).toBe(0);
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });

  it('RETRY-2: error de red (sin response) → reintenta', async () => {
    const gr = makeClient();
    postMock.mockRejectedValueOnce(axiosErr(undefined, { code: 'ECONNABORTED' })).mockResolvedValueOnce(CLIENTS_OK);

    const res = await gr.fetchClients({ cantidad: 100, offset: 0 });

    expect(res.total).toBe(0);
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('RETRY-4a: 401 NO se reintenta (re-lanza en el 1er intento)', async () => {
    const gr = makeClient();
    postMock.mockRejectedValueOnce(axiosErr(401));

    await expect(gr.fetchClients({ cantidad: 100, offset: 0 })).rejects.toMatchObject({ response: { status: 401 } });
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('RETRY-4b: 400 NO se reintenta', async () => {
    const gr = makeClient();
    postMock.mockRejectedValueOnce(axiosErr(400));

    await expect(gr.fetchClients({ cantidad: 100, offset: 0 })).rejects.toMatchObject({ response: { status: 400 } });
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('RETRY-4c: error NO-axios (p.ej. parse-bug) NO se reintenta', async () => {
    const gr = makeClient();
    postMock.mockRejectedValueOnce(new Error('unexpected boom'));

    await expect(gr.fetchClients({ cantidad: 100, offset: 0 })).rejects.toThrow('unexpected boom');
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  it('RETRY-4d: 501/505 (5xx permanentes) NO se reintentan', async () => {
    const gr = makeClient();
    postMock.mockRejectedValue(axiosErr(501));

    await expect(gr.fetchClients({ cantidad: 100, offset: 0 })).rejects.toMatchObject({ response: { status: 501 } });
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('RETRY-5: 503 persistente → 4 intentos, 3 sleeps, re-lanza el 503', async () => {
    const gr = makeClient();
    postMock.mockRejectedValue(axiosErr(503));

    await expect(gr.fetchClients({ cantidad: 100, offset: 0 })).rejects.toMatchObject({ response: { status: 503 } });
    expect(postMock).toHaveBeenCalledTimes(4);
    expect(sleepSpy).toHaveBeenCalledTimes(3);
  });
});

describe('GestionRealClient — backoff', () => {
  it('BACKOFF-1: sin jitter, delays 300 / 900 / 2700', async () => {
    const gr = makeClient({ random: () => 0 });
    postMock.mockRejectedValue(axiosErr(503));

    await expect(gr.fetchClients({ cantidad: 100, offset: 0 })).rejects.toBeDefined();

    expect(sleepSpy.mock.calls.map((c) => c[0])).toEqual([300, 900, 2700]);
  });

  it('BACKOFF-1: jitter acotado en [base, 2*base) y nunca negativo', async () => {
    const gr = makeClient({ random: () => 0.999 });
    postMock.mockRejectedValueOnce(axiosErr(503)).mockResolvedValueOnce(CLIENTS_OK);

    await gr.fetchClients({ cantidad: 100, offset: 0 });

    const delay = sleepSpy.mock.calls[0][0];
    expect(delay).toBeGreaterThanOrEqual(300);
    expect(delay).toBeLessThan(600);
  });

  it('RETRY-3: 429 con Retry-After=2 → espera al menos 2000ms', async () => {
    const gr = makeClient({ random: () => 0 });
    postMock.mockRejectedValueOnce(axiosErr(429, { headers: { 'retry-after': '2' } })).mockResolvedValueOnce(CLIENTS_OK);

    await gr.fetchClients({ cantidad: 100, offset: 0 });

    expect(sleepSpy.mock.calls[0][0]).toBeGreaterThanOrEqual(2000);
  });

  it('CAP: un Retry-After gigante se clampea al techo (no congela el lock gr-sync)', async () => {
    // Retry-After: 3600s = 1h; sin cota el sleep bloquearía 1h con el lock tomado.
    const gr = makeClient({ random: () => 0 });
    postMock
      .mockRejectedValueOnce(axiosErr(429, { headers: { 'retry-after': '3600' } }))
      .mockResolvedValueOnce(CLIENTS_OK);

    await gr.fetchClients({ cantidad: 100, offset: 0 });

    // Exactamente el techo: prueba que el clamp SÍ honró el Retry-After (3.6M) y lo capó,
    // no que simplemente devolvió el backoff exponencial chico (300).
    expect(sleepSpy.mock.calls[0][0]).toBe(30000);
  });

  it('ROBUSTEZ: un random no-finito no rompe el delay (no sleep(NaN))', async () => {
    const gr = makeClient({ random: () => NaN });
    postMock.mockRejectedValueOnce(axiosErr(503)).mockResolvedValueOnce(CLIENTS_OK);

    await gr.fetchClients({ cantidad: 100, offset: 0 });

    const delay = sleepSpy.mock.calls[0][0];
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(0);
  });
});

describe('GestionRealClient — herencia y auth', () => {
  it('INHERIT-1: getServiceOrders también reintenta ante 503', async () => {
    const gr = makeClient();
    postMock.mockRejectedValueOnce(axiosErr(503)).mockResolvedValueOnce(ORDERS_OK);

    const res = await gr.getServiceOrders({});

    expect(res).toEqual([]);
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it('AUTH-1: auth se recomputa POR intento — si cambia el día AR, los passwords DIFIEREN', async () => {
    // El password diario es MD5(CUIT+SECRET+fechaAR). Si un retry cruza medianoche
    // y el auth se hoisteara FUERA del loop, el 2do intento mandaría el password de
    // ayer → GR responde error 90. Este test garantiza el recompute por intento:
    // inyecta un `now` que avanza de día entre intentos y exige passwords distintos.
    const dates = [
      new Date('2026-07-11T09:00:00Z'), // AR 2026-07-11 06:00
      new Date('2026-07-12T09:00:00Z'), // AR 2026-07-12 06:00 → día distinto
    ];
    let i = 0;
    const gr = makeClient({ now: () => dates[Math.min(i++, dates.length - 1)] });
    postMock.mockRejectedValueOnce(axiosErr(503)).mockResolvedValueOnce(CLIENTS_OK);

    await gr.fetchClients({ cantidad: 100, offset: 0 });

    const auth0 = (postMock.mock.calls[0][2] as { auth: { username: string; password: string } }).auth;
    const auth1 = (postMock.mock.calls[1][2] as { auth: { username: string; password: string } }).auth;
    expect(auth0.username).toBe('20304050607');
    expect(auth0.password).toMatch(/^[a-f0-9]{32}$/);
    expect(auth1.password).toMatch(/^[a-f0-9]{32}$/);
    expect(auth0.password).not.toBe(auth1.password); // recomputado por intento
  });
});
