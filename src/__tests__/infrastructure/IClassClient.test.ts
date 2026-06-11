import { IClassClient } from '@infrastructure/adapters/iclass/IClassClient';
import { CreateServiceOrderInput } from '@domain/ports/IClassPort';
import { IClassUnavailableError, IClassRejectedError } from '@domain/errors/iclass';

const baseInput: CreateServiceOrderInput = {
  soCode: '4274',
  customerCode: 'C1',
  customerName: 'Juan Perez',
  phone: '099111222',
  address: 'Calle Falsa 123',
  city: 'Mercedes',
  description: 'Instalación',
  // soType is now passed per-call — the adapter no longer has a defaultSoType (FASE 5).
  soType: 'INSTALACION FIBRA',
};

/**
 * Minimal axios-instance stub. Records calls and replays a scripted queue of
 * responses/errors per method. An "axios error" carries a `response.status`.
 */
function axiosError(status: number, data?: unknown) {
  const err = new Error(`HTTP ${status}`) as Error & { response?: { status: number; data?: unknown }; isAxiosError: boolean };
  err.isAxiosError = true;
  err.response = { status, data };
  return err;
}

function connError() {
  const err = new Error('ECONNREFUSED') as Error & { isAxiosError: boolean };
  err.isAxiosError = true;
  return err;
}

interface Scripted {
  post: Array<{ ok?: { data: unknown }; err?: unknown }>;
  get: Array<{ ok?: { data: unknown }; err?: unknown }>;
}

function makeHttp(script: Scripted) {
  const calls: { method: string; url: string; body?: unknown; headers?: unknown }[] = [];
  const next = (queue: Scripted['post']) => {
    const step = queue.shift();
    if (!step) throw new Error('no scripted response left');
    if (step.err) return Promise.reject(step.err);
    return Promise.resolve(step.ok);
  };
  const http = {
    post: jest.fn((url: string, body?: unknown, cfg?: { headers?: unknown }) => {
      calls.push({ method: 'POST', url, body, headers: cfg?.headers });
      return next(script.post);
    }),
    get: jest.fn((url: string, cfg?: { headers?: unknown }) => {
      calls.push({ method: 'GET', url, headers: cfg?.headers });
      return next(script.get);
    }),
  };
  return { http, calls };
}

const LOGIN_OK = { ok: { data: { access_token: 'TKN1' } } };
const CREATE_OK = { ok: { data: { codigoOS: 'OS-123', codigoCliente: 'C1', codigoEndereco: 'A1', erros: null } } };
// Shape verificado live 2026-06-11 contra api-v2.iclass.com.br: el id es `nodeId`
// (inglés) junto a `codigo`/`descricao` (portugués). La API mezcla idiomas a propósito.
const NODES_OK = {
  ok: {
    data: {
      objects: [
        { nodeId: 35270699, codigo: 'Mercedes', descricao: 'Mercedes SY' },
        { nodeId: 35270700, codigo: 'Dolores', descricao: 'Dolores SY' },
      ],
      totalobjects: 2,
      hasMoreElements: false,
    },
  },
};

const opts = {
  baseUrl: 'https://api-v2.iclass.com.br',
  username: 'user',
  password: 'pass',
  thirdPartyId: '6808841',
};

describe('IClassClient', () => {
  it('logs in and sends the Bearer token on createServiceOrder', async () => {
    const { http, calls } = makeHttp({ post: [LOGIN_OK, CREATE_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    const { orderCode } = await client.createServiceOrder(baseInput);

    expect(orderCode).toBe('OS-123');
    const login = calls.find(c => c.url === '/auth/login')!;
    expect(login.body).toEqual({ username: 'user', password: 'pass' });
    const create = calls.find(c => c.url === '/serviceorders')!;
    expect((create.headers as Record<string, string>).Authorization).toBe('Bearer TKN1');
  });

  it('builds ServiceOrderV1In with address.nodeCode = city and NO scheduledDate', async () => {
    const { http, calls } = makeHttp({ post: [LOGIN_OK, CREATE_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await client.createServiceOrder(baseInput);

    const create = calls.find(c => c.url === '/serviceorders')!;
    const body = create.body as Record<string, Record<string, unknown>>;
    expect(body.address.nodeCode).toBe('Mercedes');
    expect(body.serviceOrder).not.toHaveProperty('scheduledDate');
    // typeSOSummary must come from input.soType — NOT from a hardcoded default (FASE 5, REQ-PORT-2).
    expect(body.serviceOrder.typeSOSummary).toBe('INSTALACION FIBRA');
    expect(body.serviceOrder.customerCode).toBe('C1');
    expect(body.customer.name).toBe('Juan Perez');
    // Customer phone is forwarded to IClass as customer.mobile (CustomerIn schema).
    expect(body.customer.mobile).toBe('099111222');
    // soCode/addressCode all carry input.soCode (the task sequenceNumber).
    expect(body.serviceOrder.soCode).toBe('4274');
    expect(body.serviceOrder.addressCode).toBe('4274');
    expect(body.address.addressCode).toBe('4274');
  });

  it('maps listNodes codigo/descricao to code/description', async () => {
    const { http } = makeHttp({ post: [LOGIN_OK], get: [NODES_OK] });
    const client = new IClassClient({ ...opts, http: http as never });

    const nodes = await client.listNodes();

    expect(nodes).toEqual([
      { nodeId: 35270699, code: 'Mercedes', description: 'Mercedes SY' },
      { nodeId: 35270700, code: 'Dolores', description: 'Dolores SY' },
    ]);
  });

  it('re-logs in once on 401 and retries the original call', async () => {
    const { http, calls } = makeHttp({
      post: [LOGIN_OK, { err: axiosError(401) }, LOGIN_OK, CREATE_OK],
      get: [],
    });
    const client = new IClassClient({ ...opts, http: http as never });

    const { orderCode } = await client.createServiceOrder(baseInput);

    expect(orderCode).toBe('OS-123');
    const logins = calls.filter(c => c.url === '/auth/login');
    expect(logins).toHaveLength(2);
  });

  it('throws IClassUnavailableError if 401 persists after the retry', async () => {
    const { http } = makeHttp({
      post: [LOGIN_OK, { err: axiosError(401) }, LOGIN_OK, { err: axiosError(401) }],
      get: [],
    });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(client.createServiceOrder(baseInput)).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  it('maps 5xx to IClassUnavailableError', async () => {
    const { http } = makeHttp({ post: [LOGIN_OK, { err: axiosError(503) }], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(client.createServiceOrder(baseInput)).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  it('maps connection failure to IClassUnavailableError', async () => {
    const { http } = makeHttp({ post: [{ err: connError() }], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(client.listNodes()).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  it('soCode/addressCode come from input.soCode (NOT the customerCode), customerCode passed through', async () => {
    const longCustomer = '76e8b565-74e3-44c3-b57d-22f791d1d09e';
    const { http, calls } = makeHttp({ post: [LOGIN_OK, CREATE_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await client.createServiceOrder({ ...baseInput, soCode: '4274', customerCode: longCustomer });

    const create = calls.find(c => c.url === '/serviceorders')!;
    const body = create.body as Record<string, Record<string, unknown>>;
    const soCode = body.serviceOrder.soCode as string;
    const addressCode = body.address.addressCode as string;
    // soCode comes from input.soCode (task sequenceNumber), not derived from the customerCode.
    expect(soCode).toBe('4274');
    expect(addressCode).toBe('4274');
    expect(body.serviceOrder.addressCode).toBe('4274');
    expect(soCode).not.toContain(longCustomer);
    expect(addressCode).not.toContain(longCustomer);
    expect(soCode).toBe(addressCode);
    expect(body.serviceOrder.customerCode).toBe(longCustomer);
  });

  it('200 with erros → IClassRejectedError carrying the detail (NOT IClassUnavailableError)', async () => {
    const { http } = makeHttp({
      post: [
        LOGIN_OK,
        { ok: { data: { codigoOS: null, erros: [{ code: 'ICLERR_0045', description: 'codigoCliente ultrapassou o limite' }] } } },
      ],
      get: [],
    });
    const client = new IClassClient({ ...opts, http: http as never });

    const err = await client.createServiceOrder(baseInput).catch(e => e);
    expect(err).toBeInstanceOf(IClassRejectedError);
    expect(err).not.toBeInstanceOf(IClassUnavailableError);
    expect(err.code).toBe('ICLASS_REJECTED');
    expect(err.detail).toContain('ICLERR_0045');
    expect(err.detail).toContain('codigoCliente ultrapassou o limite');
  });

  it('HTTP 400 with erros body → IClassRejectedError (NOT IClassUnavailableError)', async () => {
    const { http } = makeHttp({
      post: [
        LOGIN_OK,
        { err: axiosError(400, { erros: [{ code: 'ICLERR_0050', description: 'codigoOS ultrapassou o limite de caracteres' }] }) },
      ],
      get: [],
    });
    const client = new IClassClient({ ...opts, http: http as never });

    const err = await client.createServiceOrder(baseInput).catch(e => e);
    expect(err).toBeInstanceOf(IClassRejectedError);
    expect(err).not.toBeInstanceOf(IClassUnavailableError);
    expect(err.detail).toContain('ICLERR_0050');
  });

  it('caches listNodes within the TTL (single HTTP fetch)', async () => {
    const { http } = makeHttp({ post: [LOGIN_OK], get: [NODES_OK] });
    const client = new IClassClient({ ...opts, http: http as never, nodesCacheTtlMs: 60000 });

    await client.listNodes();
    await client.listNodes();

    expect(http.get).toHaveBeenCalledTimes(1);
  });

  it('returns mapped types only (never raw IClass JSON)', async () => {
    const { http } = makeHttp({ post: [LOGIN_OK], get: [NODES_OK] });
    const client = new IClassClient({ ...opts, http: http as never });

    const nodes = await client.listNodes();
    for (const n of nodes) {
      expect(Object.keys(n).sort()).toEqual(['code', 'description', 'nodeId']);
    }
  });

  // ── listServiceOrderTypes (FASE 4) ──────────────────────────────────────────

  it('listServiceOrderTypes: maps codigo/descricao to code/description', async () => {
    const SO_TYPES_OK = {
      ok: {
        data: {
          objects: [
            { codigo: 'INSTALL', descricao: 'Instalación' },
            { codigo: 'REPAIR ', descricao: ' Reparación ' }, // intentional trailing spaces
          ],
        },
      },
    };
    const { http, calls } = makeHttp({ post: [LOGIN_OK], get: [SO_TYPES_OK] });
    const client = new IClassClient({ ...opts, http: http as never });

    const types = await client.listServiceOrderTypes();

    expect(types).toHaveLength(2);
    expect(types[0]).toEqual({ code: 'INSTALL', description: 'Instalación' });
    // Trailing spaces trimmed on both sides
    expect(types[1]).toEqual({ code: 'REPAIR', description: 'Reparación' });

    const getCall = calls.find(c => c.method === 'GET' && String(c.url).includes('serviceorders/types'));
    expect(getCall).toBeTruthy();
    expect(getCall!.url).toContain(`/thirdparties/${opts.thirdPartyId}/serviceorders/types`);
    expect(getCall!.url).toContain('pagesize=200');
  });

  it('listServiceOrderTypes: re-logs in once on 401 and retries', async () => {
    const SO_TYPES_OK = {
      ok: {
        data: { objects: [{ codigo: 'INSTALL', descricao: 'Instalación' }] },
      },
    };
    const { http, calls } = makeHttp({
      post: [LOGIN_OK, LOGIN_OK],
      get: [{ err: axiosError(401) }, SO_TYPES_OK],
    });
    const client = new IClassClient({ ...opts, http: http as never });
    // Pre-warm the token so withAuthRetry skips the first login
    // (the 401 on GET triggers a re-login + retry)
    (client as unknown as { token: string }).token = 'OLD';
    const types = await client.listServiceOrderTypes();
    expect(types).toHaveLength(1);
    const logins = calls.filter(c => c.url === '/auth/login');
    expect(logins).toHaveLength(1); // one re-login
  });

  it('listServiceOrderTypes: filters out entries with empty code (defensive)', async () => {
    const SO_TYPES_WITH_EMPTY = {
      ok: {
        data: {
          objects: [
            { codigo: 'INSTALL', descricao: 'Instalación' },
            { codigo: '   ', descricao: 'Empty code after trim' }, // becomes empty after trim
            { codigo: 'REPAIR', descricao: 'Reparación' },
          ],
        },
      },
    };
    const { http } = makeHttp({ post: [LOGIN_OK], get: [SO_TYPES_WITH_EMPTY] });
    const client = new IClassClient({ ...opts, http: http as never });

    const types = await client.listServiceOrderTypes();

    // Entry with empty code after trimming is filtered out
    expect(types).toHaveLength(2);
    expect(types.every(t => t.code.length > 0)).toBe(true);
  });

  it('listServiceOrderTypes: connection failure → IClassUnavailableError', async () => {
    const { http } = makeHttp({ post: [LOGIN_OK], get: [{ err: connError() }] });
    const client = new IClassClient({ ...opts, http: http as never });
    (client as unknown as { token: string }).token = 'OLD'; // skip initial login
    await expect(client.listServiceOrderTypes()).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  // ── soType guard (FASE 5 — REQ-PORT-2) ────────────────────────────────────────

  it('createServiceOrder: empty soType → throws (programmer error; adapter MUST NOT default)', async () => {
    // The adapter has no defaultSoType. Passing an empty soType is a programmer
    // error — callers are responsible for resolving the type from the Project mapping.
    // Option A chosen: throw immediately at adapter boundary rather than letting
    // IClass return a 400 (faster feedback, clearer error message).
    const { http } = makeHttp({ post: [LOGIN_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(
      client.createServiceOrder({ ...baseInput, soType: '' }),
    ).rejects.toThrow('soType is required');
  });

  it('createServiceOrder: whitespace-only soType → throws', async () => {
    const { http } = makeHttp({ post: [LOGIN_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(
      client.createServiceOrder({ ...baseInput, soType: '   ' }),
    ).rejects.toThrow('soType is required');
  });

  // ── nodeCode override (T-10) ────────────────────────────────────────────────

  it('nodeCode override: address.nodeCode = input.nodeCode when provided (not city)', async () => {
    const { http, calls } = makeHttp({ post: [LOGIN_OK, CREATE_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await client.createServiceOrder({ ...baseInput, city: 'Mercedes', nodeCode: 'Lujan' });

    const create = calls.find(c => c.url === '/serviceorders')!;
    const body = create.body as Record<string, Record<string, unknown>>;
    // With override, nodeCode must come from input.nodeCode
    expect(body.address.nodeCode).toBe('Lujan');
  });

  it('nodeCode regression: address.nodeCode = city when nodeCode is not provided (default unchanged)', async () => {
    const { http, calls } = makeHttp({ post: [LOGIN_OK, CREATE_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await client.createServiceOrder({ ...baseInput, city: 'Mercedes' }); // no nodeCode

    const create = calls.find(c => c.url === '/serviceorders')!;
    const body = create.body as Record<string, Record<string, unknown>>;
    // Without override, nodeCode falls back to city
    expect(body.address.nodeCode).toBe('Mercedes');
  });
});
