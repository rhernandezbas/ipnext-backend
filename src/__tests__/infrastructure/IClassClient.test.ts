import { IClassClient, formatCloseDate } from '@infrastructure/adapters/iclass/IClassClient';
import { CreateServiceOrderInput } from '@domain/ports/IClassPort';
import { IClassUnavailableError, IClassRejectedError } from '@domain/errors/iclass';

const baseInput: CreateServiceOrderInput = {
  soCode: '4274',
  customerCode: 'C1',
  // #121 — addressCode is now a distinct field (the contract / stable address key),
  // independent from soCode (the per-OS matching key = sequenceNumber).
  addressCode: 'CTR-1',
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
    // #121 — soCode carries input.soCode (sequenceNumber, matching key);
    // addressCode carries input.addressCode (contract, stable per-address key).
    expect(body.serviceOrder.soCode).toBe('4274');
    expect(body.serviceOrder.addressCode).toBe('CTR-1');
    expect(body.address.addressCode).toBe('CTR-1');
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

  it('#121 — soCode comes from input.soCode; addressCode from input.addressCode (independent), customerCode passed through', async () => {
    const longCustomer = '76e8b565-74e3-44c3-b57d-22f791d1d09e';
    const { http, calls } = makeHttp({ post: [LOGIN_OK, CREATE_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await client.createServiceOrder({ ...baseInput, soCode: '4274', addressCode: 'CTR-204382', customerCode: longCustomer });

    const create = calls.find(c => c.url === '/serviceorders')!;
    const body = create.body as Record<string, Record<string, unknown>>;
    const soCode = body.serviceOrder.soCode as string;
    const addressCode = body.address.addressCode as string;
    // soCode comes from input.soCode (task sequenceNumber); NOT derived from the customerCode.
    expect(soCode).toBe('4274');
    // addressCode comes from input.addressCode (the contract); independent of soCode.
    expect(addressCode).toBe('CTR-204382');
    expect(body.serviceOrder.addressCode).toBe('CTR-204382');
    expect(soCode).not.toContain(longCustomer);
    expect(addressCode).not.toContain(longCustomer);
    // #121 — soCode and addressCode are now distinct keys.
    expect(soCode).not.toBe(addressCode);
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

  // ── A1: getServiceOrder 200 → parsea snapshot ─────────────────────────────

  it('A1: getServiceOrder 200 → returns snapshot with statusCode/statusDescription', async () => {
    const GET_OS_OK = {
      ok: {
        data: {
          id: 'iclass-42',
          codigo: 'OS-100',
          status: { id: '1', descricao: 'Aberta' },
          contrato: {}, endereco: {}, node: {}, equipe: {}, tipoOs: {}, criadoPor: {}, alteradoPor: {}, credenciada: {}, coordenadasFechamento: {},
        },
      },
    };
    const { http, calls } = makeHttp({ post: [LOGIN_OK], get: [GET_OS_OK] });
    const client = new IClassClient({ ...opts, http: http as never });
    (client as any).token = 'TKN1'; // skip login

    const snapshot = await client.getServiceOrder('iclass-42');

    expect(snapshot).not.toBeNull();
    expect(snapshot!.iclassId).toBe('iclass-42');
    expect(snapshot!.iclassCodigo).toBe('OS-100');
    expect(snapshot!.statusCode).toBe('1');
    expect(snapshot!.statusDescription).toBe('Aberta');
    const getCall = calls.find(c => c.method === 'GET' && c.url.includes('/serviceorders/iclass-42'));
    expect(getCall).toBeTruthy();
  });

  // ── A2: getServiceOrder 404/204 → null ───────────────────────────────────

  it('A2: getServiceOrder 404 → null (OS unknown to IClass)', async () => {
    const { http } = makeHttp({ post: [], get: [{ err: axiosError(404) }] });
    const client = new IClassClient({ ...opts, http: http as never });
    (client as any).token = 'TKN1';

    const result = await client.getServiceOrder('unknown-id');
    expect(result).toBeNull();
  });

  it('A2b: getServiceOrder empty body (204-style) → null', async () => {
    const { http } = makeHttp({ post: [], get: [{ ok: { data: null } }] });
    const client = new IClassClient({ ...opts, http: http as never });
    (client as any).token = 'TKN1';

    const result = await client.getServiceOrder('any-id');
    expect(result).toBeNull();
  });

  // ── A3: closeServiceOrder success → void, correct payload ────────────────

  it('A3: closeServiceOrder sends correct payload and resolves void', async () => {
    const CLOSE_OK = { ok: { data: { erros: null } } };
    const { http, calls } = makeHttp({ post: [LOGIN_OK, CLOSE_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    const closeDate = new Date('2026-07-25T10:30:00.000Z');
    await client.closeServiceOrder({
      serviceOrderCode: 'OS-100',
      resultCode: 'RESOLVIDO',
      closeDate,
      commentary: 'Cierre manual desde Prominense',
    });

    const closeCall = calls.find(c => c.url === '/serviceorders/close')!;
    expect(closeCall).toBeTruthy();
    const body = closeCall.body as Record<string, unknown>;
    expect(body['serviceOrderCode']).toBe('OS-100');
    expect(body['resultCode']).toBe('RESOLVIDO');
    expect(body['commentary']).toBe('Cierre manual desde Prominense');
    expect(typeof body['closeDate']).toBe('string');
  });

  // ── A4: closeServiceOrder erros → IClassRejectedError ────────────────────

  it('A4: closeServiceOrder with erros → IClassRejectedError with detail', async () => {
    const CLOSE_REJECTED = {
      ok: {
        data: {
          erros: [{ code: 'ICLERR_CLOSE_01', description: 'OS ya procesada' }],
        },
      },
    };
    const { http } = makeHttp({ post: [LOGIN_OK, CLOSE_REJECTED], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    const err = await client.closeServiceOrder({
      serviceOrderCode: 'OS-100',
      resultCode: 'RESOLVIDO',
      closeDate: new Date(),
      commentary: 'test',
    }).catch(e => e);

    expect(err).toBeInstanceOf(IClassRejectedError);
    expect(err.detail).toContain('ICLERR_CLOSE_01');
    expect(err.detail).toContain('OS ya procesada');
  });

  // ── A5: closeServiceOrder 5xx → IClassUnavailableError ───────────────────

  it('A5: closeServiceOrder 5xx → IClassUnavailableError', async () => {
    const { http } = makeHttp({ post: [LOGIN_OK, { err: axiosError(500) }], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(
      client.closeServiceOrder({ serviceOrderCode: 'OS-100', resultCode: 'R', closeDate: new Date(), commentary: 'x' })
    ).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  // ── A9: closeDate formatted to IClass format ──────────────────────────────
  // FIX closeDate — IClass devuelve HTTP 417 "Index 2 out of bounds for length 2"
  // cuando el closeDate viene con solo 2 tokens ("dd/MM/yyyy HH:mm:ss"). El parser
  // de IClass hace split por espacio y espera el offset de zona como 3er token.
  // El formato CORRECTO es "yyyy-MM-dd HH:mm:ss -0000" (3 tokens, en UTC con offset).

  it('A9: formatCloseDate formats date as "yyyy-MM-dd HH:mm:ss -0000" (3 tokens, UTC)', () => {
    const d = new Date('2026-07-25T10:30:45.000Z'); // UTC explícito
    expect(formatCloseDate(d)).toBe('2026-07-25 10:30:45 -0000');
  });

  it('A9b: formatCloseDate zero-pads single-digit values (UTC)', () => {
    const d = new Date('2026-01-05T09:05:03.000Z'); // UTC explícito
    expect(formatCloseDate(d)).toBe('2026-01-05 09:05:03 -0000');
  });

  it('A9c: formatCloseDate output splits into exactly 3 space-separated tokens', () => {
    // Regresión directa del bug: el viejo formato producía 2 tokens → 417.
    const d = new Date('2026-07-25T10:30:45.000Z');
    expect(formatCloseDate(d).split(' ')).toHaveLength(3);
  });

  // ── A7: listTeams → maps login/name/thirdPartyCode, filters empty login ──

  it('A7: listTeams maps login/name/thirdPartyCode and filters empty login', async () => {
    const TEAMS_OK = {
      ok: {
        data: {
          objects: [
            { login: 'equipe-01', name: 'Equipe Alpha', thirdPartyCode: '6808841' },
            { login: '  ', name: 'Empty login team', thirdPartyCode: null }, // filtered
            { login: 'equipe-02', name: 'Equipe Beta', thirdPartyCode: null },
          ],
          hasMoreElements: false,
        },
      },
    };
    const { http, calls } = makeHttp({ post: [LOGIN_OK], get: [TEAMS_OK] });
    const client = new IClassClient({ ...opts, http: http as never });
    (client as any).token = 'TKN1';

    const teams = await client.listTeams();

    expect(teams).toHaveLength(2);
    expect(teams[0]).toEqual({ login: 'equipe-01', name: 'Equipe Alpha', thirdPartyCode: '6808841' });
    expect(teams[1]).toEqual({ login: 'equipe-02', name: 'Equipe Beta', thirdPartyCode: null });
    const getCall = calls.find(c => c.method === 'GET' && String(c.url).includes('/teams'));
    expect(getCall).toBeTruthy();
    expect(getCall!.url).toContain(opts.thirdPartyId);
  });

  // ── A8: updateServiceOrder → sends requiredTeam payload ──────────────────

  it('A8: updateServiceOrder sends correct payload with requiredTeam', async () => {
    const UPDATE_OK = { ok: { data: { erros: null } } };
    const { http, calls } = makeHttp({ post: [LOGIN_OK, UPDATE_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await client.updateServiceOrder({ serviceOrderCode: 'OS-100', requiredTeam: 'equipe-01' });

    const updateCall = calls.find(c => c.url === '/serviceorders/update')!;
    expect(updateCall).toBeTruthy();
    const body = updateCall.body as Record<string, unknown>;
    expect(body['serviceOrderCode']).toBe('OS-100');
    expect(body['requiredTeam']).toBe('equipe-01');
  });

  // ── FIX 1: rate-limit-200 ("Espere um pouco") in write methods → IClassUnavailableError ──
  // IClass returns its rate-limit as HTTP 200 with plain-text body. Without the fix,
  // `data.erros` is `undefined` on a string → silent success (OS never closed in IClass).

  it('RL-1: closeServiceOrder rate-limit-200 → IClassUnavailableError (not silent success)', async () => {
    // IClass responds 200 with "Espere um pouco..." body — rate-limit disguised as success.
    const RATE_LIMIT_200 = { ok: { data: 'Espere um pouco, por favor' } };
    const { http } = makeHttp({ post: [LOGIN_OK, RATE_LIMIT_200], get: [] });
    const client = new IClassClient({
      ...opts,
      http: http as never,
      subresourceBackoffMs: 0,
      maxRateLimitRetries: 0, // no retry — first hit should throw immediately
    });

    await expect(
      client.closeServiceOrder({ serviceOrderCode: 'OS-100', resultCode: 'R', closeDate: new Date(), commentary: 'x' }),
    ).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  it('RL-2: updateServiceOrder rate-limit-200 → IClassUnavailableError (not silent success)', async () => {
    const RATE_LIMIT_200 = { ok: { data: 'Espere um pouco, por favor' } };
    const { http } = makeHttp({ post: [LOGIN_OK, RATE_LIMIT_200], get: [] });
    const client = new IClassClient({
      ...opts,
      http: http as never,
      subresourceBackoffMs: 0,
      maxRateLimitRetries: 0,
    });

    await expect(
      client.updateServiceOrder({ serviceOrderCode: 'OS-100', requiredTeam: 'equipe-01' }),
    ).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  it('RL-3: getServiceOrder rate-limit-200 → IClassUnavailableError (never null — AD-5)', async () => {
    // A rate-limit on getServiceOrder must NOT return null (which would be
    // interpreted as "OS not found") — it must throw IClassUnavailableError.
    const RATE_LIMIT_200 = { ok: { data: 'Espere um pouco, por favor' } };
    const { http } = makeHttp({ post: [], get: [RATE_LIMIT_200] });
    const client = new IClassClient({
      ...opts,
      http: http as never,
      subresourceBackoffMs: 0,
      maxRateLimitRetries: 0,
    });
    (client as any).token = 'TKN1'; // skip login

    await expect(
      client.getServiceOrder('iclass-42'),
    ).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  // ── FIX 2: closeServiceOrder/updateServiceOrder reject unexpected 200 body shapes ──
  // AD-4: never accept silence as success. Only a recognizable object body is OK.

  it('FIX2-1: closeServiceOrder 200 empty object {} → IClassUnavailableError (no positive token)', async () => {
    // {} has no `erros` but also no positive success indicator → AD-4 violation if accepted.
    const EMPTY_BODY = { ok: { data: {} } };
    const { http } = makeHttp({ post: [LOGIN_OK, EMPTY_BODY], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(
      client.closeServiceOrder({ serviceOrderCode: 'OS-100', resultCode: 'R', closeDate: new Date(), commentary: 'x' }),
    ).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  it('FIX2-2: closeServiceOrder 200 null body → IClassUnavailableError', async () => {
    const NULL_BODY = { ok: { data: null } };
    const { http } = makeHttp({ post: [LOGIN_OK, NULL_BODY], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(
      client.closeServiceOrder({ serviceOrderCode: 'OS-100', resultCode: 'R', closeDate: new Date(), commentary: 'x' }),
    ).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  it('FIX2-3: closeServiceOrder 200 HTML string → IClassUnavailableError', async () => {
    const HTML_BODY = { ok: { data: '<html><body>Error</body></html>' } };
    const { http } = makeHttp({ post: [LOGIN_OK, HTML_BODY], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(
      client.closeServiceOrder({ serviceOrderCode: 'OS-100', resultCode: 'R', closeDate: new Date(), commentary: 'x' }),
    ).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  it('FIX2-4: updateServiceOrder 200 empty object {} → IClassUnavailableError', async () => {
    const EMPTY_BODY = { ok: { data: {} } };
    const { http } = makeHttp({ post: [LOGIN_OK, EMPTY_BODY], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(
      client.updateServiceOrder({ serviceOrderCode: 'OS-100', requiredTeam: 'equipe-01' }),
    ).rejects.toBeInstanceOf(IClassUnavailableError);
  });

  // ── Regression: erros=null is the only accepted success indicator ──────────
  // These ensure the existing A3/A8 tests continue to pass after FIX 2 tightening.
  it('FIX2-REG: closeServiceOrder 200 {erros:null} → still resolves void (erros=null is the success indicator)', async () => {
    const CLOSE_OK = { ok: { data: { erros: null } } };
    const { http } = makeHttp({ post: [LOGIN_OK, CLOSE_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(
      client.closeServiceOrder({ serviceOrderCode: 'OS-100', resultCode: 'R', closeDate: new Date(), commentary: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('FIX2-REG2: updateServiceOrder 200 {erros:null} → still resolves void', async () => {
    const UPDATE_OK = { ok: { data: { erros: null } } };
    const { http } = makeHttp({ post: [LOGIN_OK, UPDATE_OK], get: [] });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(
      client.updateServiceOrder({ serviceOrderCode: 'OS-100', requiredTeam: 'equipe-01' }),
    ).resolves.toBeUndefined();
  });
});
