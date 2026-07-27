import axios, { AxiosError } from 'axios';
import { GestionRealClient } from '@infrastructure/adapters/gestion-real/GestionRealClient';

jest.mock('axios');

function axiosErr(status: number): AxiosError {
  const err = new Error(`HTTP ${status}`) as AxiosError;
  err.isAxiosError = true;
  err.response = { status } as AxiosError['response'];
  return err;
}

/**
 * finance-growth Fase 1 — pins `fetchReceipts`'s request shape. Molde
 * `GestionRealClient.retry.test.ts`: axios mocked, `post` driven directly.
 * The load-bearing assertion is that `fecha_desde`/`fecha_hasta` travel
 * EXACTLY as given (DD-MM-AAAA) — `recibos` responds HTTP 500 (not error 91)
 * on an ISO date, so a naive `.toISOString()` reformat here would be a silent
 * regression, not a caught error.
 */
const RECIBOS_EMPTY = { data: { resultados: '0', recibos: {} } };

let postMock: jest.Mock;

function makeClient(now?: () => Date) {
  postMock = jest.fn();
  (axios.create as jest.Mock).mockReturnValue({ post: postMock } as unknown as ReturnType<typeof axios.create>);
  return new GestionRealClient({
    baseUrl: 'https://gr.test/',
    cuit: '20304050607',
    secret: 'SECRET',
    now: now ?? (() => new Date('2026-07-11T09:00:00Z')),
    sleep: async () => {}, // no real delay in tests
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GestionRealClient.fetchReceipts — request shape', () => {
  it('sends fecha_desde/fecha_hasta EXACTLY as given (DD-MM-AAAA, never reformatted to ISO)', async () => {
    const gr = makeClient();
    postMock.mockResolvedValueOnce(RECIBOS_EMPTY);

    await gr.fetchReceipts({ fechaDesde: '01-06-2026', fechaHasta: '30-06-2026', cantidad: 100, offset: 0 });

    expect(postMock).toHaveBeenCalledTimes(1);
    const [, body] = postMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({
      action: 'recibos',
      fecha_desde: '01-06-2026',
      fecha_hasta: '30-06-2026',
      cantidad: 100,
      offset: 0,
    });
    // Never an ISO string.
    expect(body.fecha_desde).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.fecha_hasta).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // ── hueco de cobertura #7 — spec.md lists "password rotation at AR
  // midnight" as an explicit scenario for the receipts ingest; it rides on
  // `postWithRetry`'s pre-existing per-attempt auth recompute (already
  // verified generically for `fetchClients` as "AUTH-1" in
  // GestionRealClient.retry.test.ts), but had no test tied to `fetchReceipts`
  // itself. This closes that gap directly on the new method.
  it('AUTH-1 (receipts): auth se recomputa POR intento — un retry que cruza medianoche AR manda un password DISTINTO, nunca el de ayer', async () => {
    const dates = [
      new Date('2026-07-11T09:00:00Z'), // AR 2026-07-11 06:00
      new Date('2026-07-12T09:00:00Z'), // AR 2026-07-12 06:00 → día distinto
    ];
    let i = 0;
    const gr = makeClient(() => dates[Math.min(i++, dates.length - 1)]);
    postMock.mockRejectedValueOnce(axiosErr(503)).mockResolvedValueOnce(RECIBOS_EMPTY);

    await gr.fetchReceipts({ fechaDesde: '01-06-2026', fechaHasta: '30-06-2026', cantidad: 100, offset: 0 });

    expect(postMock).toHaveBeenCalledTimes(2);
    const auth0 = (postMock.mock.calls[0]?.[2] as { auth: { username: string; password: string } }).auth;
    const auth1 = (postMock.mock.calls[1]?.[2] as { auth: { username: string; password: string } }).auth;
    expect(auth0.password).toMatch(/^[a-f0-9]{32}$/);
    expect(auth1.password).toMatch(/^[a-f0-9]{32}$/);
    expect(auth0.password).not.toBe(auth1.password); // recomputado por intento, nunca cacheado
  });
});
