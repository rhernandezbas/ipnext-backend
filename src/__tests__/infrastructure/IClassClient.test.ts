import { IClassClient } from '@infrastructure/adapters/iclass/IClassClient';
import { CreateServiceOrderInput } from '@domain/ports/IClassPort';
import { IClassUnavailableError } from '@domain/errors/iclass';

const baseInput: CreateServiceOrderInput = {
  customerCode: 'C1',
  customerName: 'Juan Perez',
  phone: '099111222',
  address: 'Calle Falsa 123',
  city: 'Mercedes',
  description: 'Instalación',
};

/**
 * Minimal axios-instance stub. Records calls and replays a scripted queue of
 * responses/errors per method. An "axios error" carries a `response.status`.
 */
function axiosError(status: number) {
  const err = new Error(`HTTP ${status}`) as Error & { response?: { status: number }; isAxiosError: boolean };
  err.isAxiosError = true;
  err.response = { status };
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
const NODES_OK = {
  ok: {
    data: {
      objects: [
        { codigo: 'Mercedes', descricao: 'Mercedes SY' },
        { codigo: 'Dolores', descricao: 'Dolores SY' },
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
  defaultSoType: 'INSTALL',
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
    expect(body.serviceOrder.typeSOSummary).toBe('INSTALL');
    expect(body.serviceOrder.customerCode).toBe('C1');
    expect(body.customer.name).toBe('Juan Perez');
  });

  it('maps listNodes codigo/descricao to code/description', async () => {
    const { http } = makeHttp({ post: [LOGIN_OK], get: [NODES_OK] });
    const client = new IClassClient({ ...opts, http: http as never });

    const nodes = await client.listNodes();

    expect(nodes).toEqual([
      { code: 'Mercedes', description: 'Mercedes SY' },
      { code: 'Dolores', description: 'Dolores SY' },
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

  it('throws IClassUnavailableError when IClass returns erros (not null)', async () => {
    const { http } = makeHttp({
      post: [LOGIN_OK, { ok: { data: { codigoOS: null, erros: 'ICLERR_0014' } } }],
      get: [],
    });
    const client = new IClassClient({ ...opts, http: http as never });

    await expect(client.createServiceOrder(baseInput)).rejects.toBeInstanceOf(IClassUnavailableError);
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
      expect(Object.keys(n).sort()).toEqual(['code', 'description']);
    }
  });
});
