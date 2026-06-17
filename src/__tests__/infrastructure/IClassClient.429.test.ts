/**
 * Tests for IClassClient HTTP 429 retry handling (REQ-429-RETRY-1).
 * Also covers 429 on the new write methods (FIX 4, matrix A6):
 *   - getServiceOrder (authedGetOrNull path)
 *   - closeServiceOrder (authedPost / withAuthRetry path)
 *   - updateServiceOrder (authedPost / withAuthRetry path)
 *
 * NOTE on write-method idempotency risk: a 429 retry on closeServiceOrder or
 * updateServiceOrder could double-send if the first attempt *did* reach IClass
 * before the 429 was returned. This is an IClass API limitation; the live
 * validation (§10) should confirm whether the endpoints are idempotent.
 *
 * Strategy: inject a fake `http` axios instance that returns scripted
 * responses/errors. `subresourceBackoffMs: 0` and `maxRateLimitRetries`
 * small so there are NO real sleeps and bounded loops.
 */
import { IClassClient } from '@infrastructure/adapters/iclass/IClassClient';
import { IClassUnavailableError } from '@domain/errors/iclass';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fake axios-style 429 error (isAxiosError + response.status + optional headers). */
function rateLimitError(headers: Record<string, unknown> = {}) {
  const err = Object.assign(new Error('HTTP 429'), {
    isAxiosError: true as const,
    response: { status: 429, headers, data: undefined },
  });
  return err;
}

/** Fake axios-style 200 success (used for login + data responses). */
function okResponse(data: unknown) {
  return Promise.resolve({ data });
}

/** Scripted http stub: consumes queued entries per method. */
function makeHttp(postQueue: Array<() => unknown>, getQueue: Array<() => unknown>) {
  return {
    post: jest.fn(() => {
      const next = postQueue.shift();
      if (!next) throw new Error('No more scripted POST responses');
      const result = next();
      return result instanceof Error ? Promise.reject(result) : Promise.resolve({ data: result });
    }),
    get: jest.fn(() => {
      const next = getQueue.shift();
      if (!next) throw new Error('No more scripted GET responses');
      const result = next();
      return result instanceof Error ? Promise.reject(result) : Promise.resolve({ data: result });
    }),
  };
}

/** Fake axios-style 500 error. */
function serverError() {
  return Object.assign(new Error('HTTP 500'), {
    isAxiosError: true as const,
    response: { status: 500, headers: {}, data: undefined },
  });
}

const LOGIN_TOKEN = { access_token: 'TKN' };
const NODES_DATA = { objects: [{ nodeId: 7, codigo: 'M', descricao: 'Mercedes' }], hasMoreElements: false };

// ── Task 1.1: 429 on attempt 1 → succeeds on attempt 2, returns data ─────────

describe('IClassClient — 429 retry (REQ-429-RETRY-1)', () => {
  it('1.1: retries after 429, returns data from the successful attempt', async () => {
    const sleepCalls: number[] = [];
    const fakeSleep = (ms: number) => { sleepCalls.push(ms); return Promise.resolve(); };

    // POST: login succeeds
    // GET: first attempt → 429, second → 200 with nodes data
    const http = {
      post: jest.fn().mockResolvedValueOnce({ data: LOGIN_TOKEN }),
      get: jest.fn()
        .mockRejectedValueOnce(rateLimitError())
        .mockResolvedValueOnce({ data: NODES_DATA }),
    };

    const client = new IClassClient({
      baseUrl: 'http://test',
      username: 'u',
      password: 'p',
      thirdPartyId: 'tp1',
      http: http as any,
      subresourceBackoffMs: 0,
      maxRateLimitRetries: 3,
      _sleep: fakeSleep,
    });

    const nodes = await client.listNodes();

    // Data returned transparently from the successful attempt
    expect(nodes).toEqual([{ nodeId: 7, code: 'M', description: 'Mercedes' }]);
    // Sleep was called exactly once (before the retry)
    expect(sleepCalls).toHaveLength(1);
  });

  // ── Task 1.2: Retry-After header takes precedence over backoff ────────────

  it('1.2: Retry-After: 2 → sleep receives 2000ms, backoff NOT used', async () => {
    const sleepCalls: number[] = [];
    const fakeSleep = (ms: number) => { sleepCalls.push(ms); return Promise.resolve(); };

    const http = {
      post: jest.fn().mockResolvedValueOnce({ data: LOGIN_TOKEN }),
      get: jest.fn()
        .mockRejectedValueOnce(rateLimitError({ 'retry-after': '2' }))
        .mockResolvedValueOnce({ data: NODES_DATA }),
    };

    const client = new IClassClient({
      baseUrl: 'http://test',
      username: 'u',
      password: 'p',
      thirdPartyId: 'tp1',
      http: http as any,
      subresourceBackoffMs: 9999, // non-zero to confirm it is NOT used
      maxRateLimitRetries: 3,
      _sleep: fakeSleep,
    });

    await client.listNodes();

    // Retry-After: 2 → 2000 ms
    expect(sleepCalls).toEqual([2000]);
  });

  // ── Task 1.3: always-429 with maxRateLimitRetries=3 → throws after 4 attempts, sleep 3 times

  it('1.3: always-429 with maxRateLimitRetries=3 → throws after retries, sleep called maxRetries times', async () => {
    const sleepCalls: number[] = [];
    const fakeSleep = (ms: number) => { sleepCalls.push(ms); return Promise.resolve(); };

    // loop runs for attempt 0..maxRateLimitRetries (0..3 inclusive = 4 total):
    // attempt 0 → 429, 0 < 3 → sleep (1), continue
    // attempt 1 → 429, 1 < 3 → sleep (2), continue
    // attempt 2 → 429, 2 < 3 → sleep (3), continue
    // attempt 3 → 429, 3 < 3 is FALSE → mapError (throws)
    // sleep called exactly 3 times = maxRateLimitRetries
    const http = {
      post: jest.fn().mockResolvedValueOnce({ data: LOGIN_TOKEN }),
      get: jest.fn()
        .mockRejectedValueOnce(rateLimitError())
        .mockRejectedValueOnce(rateLimitError())
        .mockRejectedValueOnce(rateLimitError())
        .mockRejectedValueOnce(rateLimitError()),
    };

    const client = new IClassClient({
      baseUrl: 'http://test',
      username: 'u',
      password: 'p',
      thirdPartyId: 'tp1',
      http: http as any,
      subresourceBackoffMs: 0,
      maxRateLimitRetries: 3,
      _sleep: fakeSleep,
    });

    await expect(client.listNodes()).rejects.toBeInstanceOf(IClassUnavailableError);
    // sleep called exactly maxRateLimitRetries times (3)
    expect(sleepCalls).toHaveLength(3);
  });

  // ── Task 1.4: 200 "Espere um pouco" → isRateLimited path in fetchAllPages, NOT 429 path ─

  it('1.4: 200 "Espere um pouco" on listServiceOrders → isRateLimited path fires, 429 path NOT triggered', async () => {
    const sleepSpy = jest.fn().mockResolvedValue(undefined);

    // listServiceOrders uses fetchAllPages which handles "Espere um pouco" (200 text).
    // First GET page 1 → "Espere um pouco"; second GET page 1 → valid data with no more pages.
    const ORDERS_PAGE = {
      objects: [{ id: '900', codigo: '4013', status: { id: '3', descricao: 'Em andamento' } }],
      hasMoreElements: false,
    };

    const http = {
      post: jest.fn().mockResolvedValueOnce({ data: LOGIN_TOKEN }),
      get: jest.fn()
        .mockResolvedValueOnce({ data: 'Espere um pouco' })
        .mockResolvedValueOnce({ data: ORDERS_PAGE }),
    };

    const client = new IClassClient({
      baseUrl: 'http://test',
      username: 'u',
      password: 'p',
      thirdPartyId: 'tp1',
      http: http as any,
      subresourceBackoffMs: 0,
      maxRateLimitRetries: 3,
      _sleep: sleepSpy,
    });

    const now = new Date('2026-05-29T12:00:00Z');
    const begin = new Date('2026-05-01T00:00:00Z');
    const summaries = await client.listServiceOrders({ updatedDateBegin: begin, updatedDateEnd: now });

    // Data returned successfully (1 SO found)
    expect(summaries).toHaveLength(1);
    expect(summaries[0].iclassId).toBe('900');
    // fetchAllPages called GET exactly twice: once "Espere", once valid (2 calls total, no 429 loop)
    expect(http.get).toHaveBeenCalledTimes(2);
    // isRateLimited sleep was called once (subresourceBackoffMs * 2 = 0) — the fetchAllPages path
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    // Crucially: no HTTP 429 error was ever thrown, so withAuthRetry's catch block
    // was never entered for rate-limiting → the 200-body path and the 429-status path are distinct.
  });
});

// ── A6 matrix: 429 on getServiceOrder / closeServiceOrder / updateServiceOrder ──────────────────

describe('IClassClient — 429 retry on write methods (A6)', () => {
  const BASE_OPTS = {
    baseUrl: 'http://test',
    username: 'u',
    password: 'p',
    thirdPartyId: 'tp1',
    subresourceBackoffMs: 0,
    maxRateLimitRetries: 2,
  };

  // A6-1: getServiceOrder → 429 on first attempt, succeeds on retry
  // NOTE: getServiceOrder now resolves via listServiceOrders (list endpoint), not
  // GET /serviceorders/{id}. The 429 is an HTTP 429 thrown by authedGet (inside
  // withAuthRetry). The retry returns a paginator-shaped list with the matching OS.
  it('A6-1: getServiceOrder 429 → retries and returns snapshot', async () => {
    const sleepCalls: number[] = [];
    const fakeSleep = (ms: number) => { sleepCalls.push(ms); return Promise.resolve(); };

    // Paginator response — fetchAllPages expects { objects: [...], hasMoreElements }
    const LIST_OK = {
      objects: [
        {
          id: 'iclass-1',
          codigo: 'OS-100',
          status: { id: '1', descricao: 'Aberta' },
          contrato: {}, endereco: {}, node: {}, equipe: {}, tipoOs: {},
          criadoPor: {}, alteradoPor: {}, credenciada: {}, coordenadasFechamento: {},
        },
      ],
      hasMoreElements: false,
    };

    const http = {
      post: jest.fn(), // no login needed (token pre-set)
      get: jest.fn()
        .mockRejectedValueOnce(rateLimitError())   // first GET → HTTP 429
        .mockResolvedValueOnce({ data: LIST_OK }), // retry → list with OS
    };

    const client = new IClassClient({ ...BASE_OPTS, http: http as any, _sleep: fakeSleep });
    (client as any).token = 'TKN';

    // Pass the code (codigo), NOT iclass-1 (the internal id)
    const snapshot = await client.getServiceOrder('OS-100');

    expect(snapshot).not.toBeNull();
    expect(snapshot!.iclassId).toBe('iclass-1');
    expect(sleepCalls).toHaveLength(1);
  });

  // A6-2: getServiceOrder → always 429, exhausts retries → IClassUnavailableError
  it('A6-2: getServiceOrder always 429 → IClassUnavailableError after retries', async () => {
    const fakeSleep = jest.fn().mockResolvedValue(undefined);

    const http = {
      post: jest.fn(),
      get: jest.fn()
        .mockRejectedValueOnce(rateLimitError())
        .mockRejectedValueOnce(rateLimitError())
        .mockRejectedValueOnce(rateLimitError()),
    };

    const client = new IClassClient({ ...BASE_OPTS, http: http as any, _sleep: fakeSleep });
    (client as any).token = 'TKN';

    await expect(client.getServiceOrder('iclass-1')).rejects.toBeInstanceOf(IClassUnavailableError);
    expect(fakeSleep).toHaveBeenCalledTimes(2); // maxRateLimitRetries=2
  });

  // A6-3: closeServiceOrder → 429 on first attempt, succeeds on retry
  // IDEMPOTENCY NOTE: the retry may double-send if the first request reached IClass.
  // The live validation (§10) must confirm whether /serviceorders/close is idempotent.
  it('A6-3: closeServiceOrder 429 → retries and resolves void', async () => {
    const sleepCalls: number[] = [];
    const fakeSleep = (ms: number) => { sleepCalls.push(ms); return Promise.resolve(); };

    const http = makeHttp(
      [
        () => rateLimitError(), // first POST attempt → 429
        () => ({ erros: null }), // retry → success
      ],
      [],
    );

    const client = new IClassClient({ ...BASE_OPTS, http: http as any, _sleep: fakeSleep });
    (client as any).token = 'TKN';

    await expect(
      client.closeServiceOrder({ serviceOrderCode: 'OS-100', resultCode: 'R', closeDate: new Date(), commentary: 'x' }),
    ).resolves.toBeUndefined();

    expect(sleepCalls).toHaveLength(1);
  });

  // A6-4: closeServiceOrder → always 429 → IClassUnavailableError
  it('A6-4: closeServiceOrder always 429 → IClassUnavailableError after retries', async () => {
    const fakeSleep = jest.fn().mockResolvedValue(undefined);

    const http = makeHttp(
      [
        () => rateLimitError(),
        () => rateLimitError(),
        () => rateLimitError(),
      ],
      [],
    );

    const client = new IClassClient({ ...BASE_OPTS, http: http as any, _sleep: fakeSleep });
    (client as any).token = 'TKN';

    await expect(
      client.closeServiceOrder({ serviceOrderCode: 'OS-100', resultCode: 'R', closeDate: new Date(), commentary: 'x' }),
    ).rejects.toBeInstanceOf(IClassUnavailableError);

    expect(fakeSleep).toHaveBeenCalledTimes(2);
  });

  // A6-5: updateServiceOrder → 429 on first attempt, succeeds on retry
  // IDEMPOTENCY NOTE: same risk as closeServiceOrder (see A6-3).
  it('A6-5: updateServiceOrder 429 → retries and resolves void', async () => {
    const sleepCalls: number[] = [];
    const fakeSleep = (ms: number) => { sleepCalls.push(ms); return Promise.resolve(); };

    const http = makeHttp(
      [
        () => rateLimitError(),
        () => ({ errors: [], success: true, result: {} }),
      ],
      [],
    );

    const client = new IClassClient({ ...BASE_OPTS, http: http as any, _sleep: fakeSleep });
    (client as any).token = 'TKN';

    await expect(
      client.updateServiceOrder({
        serviceOrderCode: 'OS-100',
        requiredTeam: 'equipe-01',
        scheduleStart: new Date('2026-06-18T11:00:00.000Z'),
        scheduleEnd: new Date('2026-06-18T15:00:00.000Z'),
      }),
    ).resolves.toBeUndefined();

    expect(sleepCalls).toHaveLength(1);
  });

  // A6-6: updateServiceOrder → always 429 → IClassUnavailableError
  it('A6-6: updateServiceOrder always 429 → IClassUnavailableError after retries', async () => {
    const fakeSleep = jest.fn().mockResolvedValue(undefined);

    const http = makeHttp(
      [
        () => rateLimitError(),
        () => rateLimitError(),
        () => rateLimitError(),
      ],
      [],
    );

    const client = new IClassClient({ ...BASE_OPTS, http: http as any, _sleep: fakeSleep });
    (client as any).token = 'TKN';

    await expect(
      client.updateServiceOrder({
        serviceOrderCode: 'OS-100',
        requiredTeam: 'equipe-01',
        scheduleStart: new Date('2026-06-18T11:00:00.000Z'),
        scheduleEnd: new Date('2026-06-18T15:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(IClassUnavailableError);

    expect(fakeSleep).toHaveBeenCalledTimes(2);
  });
});
