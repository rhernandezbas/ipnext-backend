/**
 * #47 — GigaredClient adapter. Axios is injected (the real API is NEVER hit).
 * Fixtures are the EXACT shapes from tv.md. Asserts:
 *  - X-API-Key header from config, read PER CALL
 *  - empty key → GigaredNotConfiguredError WITHOUT touching axios
 *  - snake→camel mapping (summary, accounts list, account detail with nulls)
 *  - exact URLs/query: use_internal_id=true, service_id
 *  - 429 + Retry-After → retry → success; 429×(n+1) → GigaredUnavailableError
 *  - 401/403 → GigaredAuthError; 404 → GigaredNotFoundError; RFC 9457 4xx → GigaredRejectedError(title,detail)
 */
import { GigaredClient } from '@infrastructure/adapters/gigared/GigaredClient';
import { InMemoryGigaredConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryGigaredConfigRepository';
import {
  GigaredNotConfiguredError,
  GigaredUnavailableError,
  GigaredAuthError,
  GigaredNotFoundError,
  GigaredRejectedError,
} from '@domain/errors/gigared';

// ---- axios test double -----------------------------------------------------
type Resp = { data: unknown };
function axiosError(status: number, opts: { data?: unknown; headers?: Record<string, unknown> } = {}) {
  return {
    isAxiosError: true,
    response: { status, data: opts.data, headers: opts.headers ?? {} },
  };
}
function makeHttp() {
  return {
    get: jest.fn<Promise<Resp>, [string, unknown?]>(),
    post: jest.fn<Promise<Resp>, [string, unknown?, unknown?]>(),
    patch: jest.fn<Promise<Resp>, [string, unknown?, unknown?]>(),
    put: jest.fn<Promise<Resp>, [string, unknown?, unknown?]>(),
    delete: jest.fn<Promise<Resp>, [string, unknown?]>(),
  };
}

function makeClient(http: ReturnType<typeof makeHttp>, key = 'mykey1234') {
  const cfg = new InMemoryGigaredConfigRepository();
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  const ready = cfg.update({ apiKey: key });
  // build client; configProvider read per call
  const client = new GigaredClient({
    configProvider: cfg,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    http: http as any,
    maxRateLimitRetries: 4,
    backoffMs: 1,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _sleep: (async () => {}) as any,
  });
  return { client, cfg, ready };
}

// ---- fixtures (tv.md verbatim shapes) --------------------------------------
const SUMMARY_FIXTURE = {
  message: 'Éxito',
  detail: {
    accounts: { registered: 3, unregistered: 997, total: 1000 },
    services: [
      { id: '129', name: 'Gigared Play Full', qty_available: 0, qty_used: 1000, qty_purchased: 1000 },
      { id: '39', name: 'Pack Todo Futbol', qty_available: 49, qty_used: 1, qty_purchased: 50 },
    ],
  },
};

const ACCOUNTS_LIST_FIXTURE = {
  message: 'Éxito',
  detail: [
    {
      crm: {
        cic: '0000000001',
        gigared_id: '10000000100',
        email: 'ejemplo@gigared.com.ar',
        first_name: 'Nombre',
        last_name: 'Apellido',
        registration_date: '19/01/2026',
        services: [{ id: '129', name: 'Gigared Play Full' }],
      },
      internal_id: 'CLIENTE_001',
      ott: {
        id: 'GIGA10000000100',
        qty_stationary_licenses: 3,
        qty_mobile_licenses: 5,
        qty_registered_devices: 0,
        status: 'deshabilitado',
      },
    },
  ],
};

const ACCOUNT_DETAIL_NULLS_FIXTURE = {
  message: 'Éxito',
  detail: {
    crm: {
      cic: '0000000001',
      gigared_id: '10000000100',
      email: null,
      first_name: null,
      last_name: null,
      registration_date: null,
      services: [{ id: '129', name: 'Gigared Play Full' }],
    },
    internal_id: 'CLIENTE_001',
    ott: {
      id: 'GIGA10000000100',
      qty_stationary_licenses: 3,
      qty_mobile_licenses: 5,
      qty_registered_devices: 0,
      status: null,
    },
  },
};

describe('GigaredClient (#47)', () => {
  describe('auth + config-per-call', () => {
    it('sends X-API-Key header from the config provider', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: SUMMARY_FIXTURE });
      const { client, ready } = makeClient(http, 'topsecret');
      await ready;
      await client.getSummary();
      const [, opts] = http.get.mock.calls[0]!;
      expect((opts as { headers: Record<string, string> }).headers['X-API-Key']).toBe('topsecret');
    });

    it('reads the key PER CALL — changing config between calls uses the new key', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: SUMMARY_FIXTURE });
      const { client, cfg, ready } = makeClient(http, 'key-one');
      await ready;
      await client.getSummary();
      await cfg.update({ apiKey: 'key-two' });
      await client.getSummary();
      const headerOf = (i: number) => (http.get.mock.calls[i]![1] as { headers: Record<string, string> }).headers['X-API-Key'];
      expect(headerOf(0)).toBe('key-one');
      expect(headerOf(1)).toBe('key-two');
    });

    it('empty key → GigaredNotConfiguredError WITHOUT touching axios', async () => {
      const http = makeHttp();
      const { client } = makeClient(http, ''); // empty
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredNotConfiguredError);
      expect(http.get).not.toHaveBeenCalled();
    });
  });

  describe('mapping snake → camel', () => {
    it('getSummary maps the partner summary fixture', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: SUMMARY_FIXTURE });
      const { client, ready } = makeClient(http);
      await ready;
      const summary = await client.getSummary();
      expect(summary.accounts).toEqual({ registered: 3, unregistered: 997, total: 1000 });
      expect(summary.services[0]).toEqual({
        id: '129', name: 'Gigared Play Full', qtyAvailable: 0, qtyUsed: 1000, qtyPurchased: 1000,
      });
    });

    it('listAccounts maps crm + internal_id + ott to camelCase', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: ACCOUNTS_LIST_FIXTURE });
      const { client, ready } = makeClient(http);
      await ready;
      const accounts = await client.listAccounts({ email: 'ejemplo@gigared.com.ar' });
      expect(accounts).toHaveLength(1);
      const a = accounts[0]!;
      expect(a.cic).toBe('0000000001');
      expect(a.gigaredId).toBe('10000000100');
      expect(a.firstName).toBe('Nombre');
      expect(a.registrationDate).toBe('19/01/2026');
      expect(a.internalId).toBe('CLIENTE_001');
      expect(a.services).toEqual([{ id: '129', name: 'Gigared Play Full' }]);
      expect(a.ott).toEqual({
        id: 'GIGA10000000100', stationaryLicenses: 3, mobileLicenses: 5, registeredDevices: 0, status: 'disabled',
      });
      // query passed through
      const [url] = http.get.mock.calls[0]!;
      expect(String(url)).toContain('/accounts');
    });

    it('getAccountByInternalId maps detail with null fields + uses use_internal_id=true', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: ACCOUNT_DETAIL_NULLS_FIXTURE });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.email).toBeNull();
      expect(a.firstName).toBeNull();
      expect(a.registrationDate).toBeNull();
      expect(a.ott!.status).toBeNull();
      const [url] = http.get.mock.calls[0]!;
      expect(String(url)).toContain('/accounts/CLIENTE_001');
      expect(String(url)).toContain('use_internal_id=true');
    });

    it('getAccountByInternalId throws GigaredNotFoundError on 404', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(404, { data: { status: 404, title: 'not found', detail: 'no account' } }));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getAccountByInternalId('NOPE')).rejects.toBeInstanceOf(GigaredNotFoundError);
    });

    it('C2: getAccountByCic → GET /accounts/{cic} WITHOUT use_internal_id', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: ACCOUNT_DETAIL_NULLS_FIXTURE });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByCic('0000000001');
      expect(a.cic).toBe('0000000001');
      const [url] = http.get.mock.calls[0]!;
      expect(String(url)).toContain('/accounts/0000000001');
      expect(String(url)).not.toContain('use_internal_id');
    });

    it('C2: getAccountByCic throws GigaredNotFoundError on 404', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(404));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getAccountByCic('NOPE')).rejects.toBeInstanceOf(GigaredNotFoundError);
    });
  });

  describe('mutations — exact URLs/queries', () => {
    it('addService → POST /services/{id}?service_id=X&use_internal_id=true', async () => {
      const http = makeHttp();
      http.post.mockResolvedValue({ data: { message: 'Éxito', detail: 'Servicio agregado con éxito' } });
      const { client, ready } = makeClient(http);
      await ready;
      await client.addService('CLIENTE_001', '129');
      const [url] = http.post.mock.calls[0]!;
      expect(String(url)).toContain('/services/CLIENTE_001');
      expect(String(url)).toContain('service_id=129');
      expect(String(url)).toContain('use_internal_id=true');
    });

    it('removeService → DELETE /services/{id}/{serviceId}?use_internal_id=true', async () => {
      const http = makeHttp();
      http.delete.mockResolvedValue({ data: { message: 'Éxito', detail: 'Servicio eliminado con éxito' } });
      const { client, ready } = makeClient(http);
      await ready;
      await client.removeService('CLIENTE_001', '129');
      const [url] = http.delete.mock.calls[0]!;
      expect(String(url)).toContain('/services/CLIENTE_001/129');
      expect(String(url)).toContain('use_internal_id=true');
    });

    it('setOtt(true) → PUT /ott/{id}/enable?use_internal_id=true', async () => {
      const http = makeHttp();
      http.put.mockResolvedValue({ data: { message: 'Éxito', detail: '...' } });
      const { client, ready } = makeClient(http);
      await ready;
      await client.setOtt('CLIENTE_001', true);
      const [url] = http.put.mock.calls[0]!;
      expect(String(url)).toContain('/ott/CLIENTE_001/enable');
      expect(String(url)).toContain('use_internal_id=true');
    });

    it('setOtt(false) → PUT /ott/{id}/disable', async () => {
      const http = makeHttp();
      http.put.mockResolvedValue({ data: { message: 'Éxito', detail: '...' } });
      const { client, ready } = makeClient(http);
      await ready;
      await client.setOtt('CLIENTE_001', false);
      const [url] = http.put.mock.calls[0]!;
      expect(String(url)).toContain('/ott/CLIENTE_001/disable');
    });

    it('setInternalId → PATCH /accounts/{cic}/internal_id with { internal_id }', async () => {
      const http = makeHttp();
      http.patch.mockResolvedValue({ data: { message: 'Éxito', detail: '...' } });
      const { client, ready } = makeClient(http);
      await ready;
      await client.setInternalId('0000000001', 'CLIENTE_001');
      const [url, body] = http.patch.mock.calls[0]!;
      expect(String(url)).toContain('/accounts/0000000001/internal_id');
      expect(body).toEqual({ internal_id: 'CLIENTE_001' });
    });

    it('changePassword → PATCH /accounts/{cic} with { password } (#65)', async () => {
      const http = makeHttp();
      http.patch.mockResolvedValue({ data: { message: 'Éxito', detail: '...' } });
      const { client, ready } = makeClient(http);
      await ready;
      await client.changePassword('0000001234', 'ip243200');
      const [url, body] = http.patch.mock.calls[0]!;
      expect(String(url)).toContain('/accounts/0000001234');
      expect(String(url)).not.toContain('/internal_id');
      expect(body).toEqual({ password: 'ip243200' });
    });

    it('renewCic → PUT /accounts/{internalId}/renew?use_internal_id=true → {oldCic,newCic}', async () => {
      const http = makeHttp();
      http.put.mockResolvedValue({
        data: { message: 'Éxito', detail: { old_cic: '0000000001', new_cic: '0000000002' } },
      });
      const { client, ready } = makeClient(http);
      await ready;
      const res = await client.renewCic('CLIENTE_001');
      const [url] = http.put.mock.calls[0]!;
      expect(String(url)).toContain('/accounts/CLIENTE_001/renew');
      expect(String(url)).toContain('use_internal_id=true');
      expect(res).toEqual({ oldCic: '0000000001', newCic: '0000000002' });
    });

    it('register → POST /accounts/register with snake_case body (send_activation_email)', async () => {
      const http = makeHttp();
      http.post.mockResolvedValue({ data: { message: 'Éxito', detail: 'Registracion iniciada correctamente' } });
      const { client, ready } = makeClient(http);
      await ready;
      await client.register({
        firstName: 'Juan', lastName: 'Pérez', email: 'e@x.com', cic: '0000000001',
        password: 'secret', sendActivationEmail: true,
      });
      const [url, body] = http.post.mock.calls[0]!;
      expect(String(url)).toContain('/accounts/register');
      expect(body).toEqual({
        first_name: 'Juan', last_name: 'Pérez', email: 'e@x.com', cic: '0000000001',
        password: 'secret', send_activation_email: true,
      });
    });

    it('activate → POST /accounts/activate with { cic, email }', async () => {
      const http = makeHttp();
      http.post.mockResolvedValue({ data: { message: 'Éxito', detail: 'Cuenta activada correctamente' } });
      const { client, ready } = makeClient(http);
      await ready;
      await client.activate({ cic: '0000000001', email: 'e@x.com' });
      const [url, body] = http.post.mock.calls[0]!;
      expect(String(url)).toContain('/accounts/activate');
      expect(body).toEqual({ cic: '0000000001', email: 'e@x.com' });
    });
  });

  describe('error mapping + retry', () => {
    it('429 + Retry-After → retries then succeeds', async () => {
      const http = makeHttp();
      http.get
        .mockRejectedValueOnce(axiosError(429, { headers: { 'retry-after': '1' } }))
        .mockResolvedValueOnce({ data: SUMMARY_FIXTURE });
      const { client, ready } = makeClient(http);
      await ready;
      const summary = await client.getSummary();
      expect(summary.accounts.total).toBe(1000);
      expect(http.get).toHaveBeenCalledTimes(2);
    });

    it('429 exhausting all retries → GigaredUnavailableError', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(429, { headers: { 'retry-after': '1' } }));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredUnavailableError);
      // initial + 4 retries = 5 attempts
      expect(http.get).toHaveBeenCalledTimes(5);
    });

    it('401 → GigaredAuthError (no relogin branch)', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(401));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredAuthError);
      expect(http.get).toHaveBeenCalledTimes(1);
    });

    it('403 → GigaredAuthError', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(403));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredAuthError);
    });

    it('RFC 9457 4xx → GigaredRejectedError carrying title + detail', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(
        axiosError(424, { data: { status: 424, title: 'Servicio externo', detail: 'Gigared CUA timeout' } }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toMatchObject({
        code: 'GIGARED_REJECTED',
        title: 'Servicio externo',
        detail: 'Gigared CUA timeout',
      });
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredRejectedError);
    });

    it('5xx → GigaredUnavailableError', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(502));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredUnavailableError);
    });

    it('network error (no response) → GigaredUnavailableError', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue({ isAxiosError: true });
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredUnavailableError);
    });
  });

  // ---- #47d — REAL Gigared error bodies (verified live 2026-06-11) ----------
  // The live API DIFFERS from its docs: "not found" is HTTP 424 (external-service-error),
  // and "CIC not owned" is HTTP 403 (cic-ownership-error) — NOT 404. mapError discriminates
  // on the RFC 9457 `type` field. Fixtures below are pinned VERBATIM from the live responses.
  describe('#47d — real Gigared RFC 9457 error mapping (verified live 2026-06-11)', () => {
    // GET /accounts/{uuid}?use_internal_id=true with an UNKNOWN internal_id → HTTP 424.
    const NOT_FOUND_424_BODY = {
      type: 'https://partners.gigaredsa.com.ar/errors/external-service-error',
      title: 'Error en servicio externo',
      status: 424,
      detail: 'No se encontró una cuenta con internal_id 8054e9f3-...',
    };

    // GET /accounts/{cic} with a CIC the reseller does NOT own → HTTP 403.
    const CIC_OWNERSHIP_403_BODY = {
      type: 'https://partners.gigaredsa.com.ar/errors/cic-ownership-error',
      title: 'Error de propiedad de CIC',
      status: 403,
      detail: 'El revendedor no posee esta cuenta',
    };

    // The genuine auth failure (invalid/missing key) must STILL be an auth error.
    const INVALID_API_KEY_403_BODY = {
      type: 'https://partners.gigaredsa.com.ar/errors/invalid-api-key',
      title: 'Clave de API inválida',
      status: 403,
      detail: 'La clave de API proporcionada no es válida',
    };

    it('(a) 424 external-service-error "no se encontró" → getAccountByInternalId throws GigaredNotFoundError (→ linked:false upstream)', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(424, { data: NOT_FOUND_424_BODY }));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getAccountByInternalId('8054e9f3-...')).rejects.toBeInstanceOf(
        GigaredNotFoundError,
      );
    });

    it('(b) 403 cic-ownership-error → getAccountByCic throws GigaredNotFoundError (→ CIC_NOT_FOUND 404 in the link)', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(403, { data: CIC_OWNERSHIP_403_BODY }));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getAccountByCic('0009999999')).rejects.toBeInstanceOf(
        GigaredNotFoundError,
      );
    });

    it('(c) regression: 403 invalid-api-key → GigaredAuthError', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(403, { data: INVALID_API_KEY_403_BODY }));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredAuthError);
    });

    it('(d) 424 WITHOUT "no se encontró" (CUA genuinely down) → GigaredUnavailableError', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(
        axiosError(424, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/external-service-error',
            title: 'Error en servicio externo',
            status: 424,
            detail: 'El servicio CUA no respondió a tiempo',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredUnavailableError);
    });

    it('(e) bare 403 without an RFC 9457 type still → GigaredAuthError (legacy/unknown bodies)', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(403));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredAuthError);
    });
  });

  // ---- #47g — filtered listing with no matches is an EMPTY RESULT, not an error -----
  // The LIVE Gigared API (verified 2026-06-11) returns HTTP 404 with RFC 9457
  // type .../empty-accounts_list when a filtered GET /accounts matches nothing.
  // That is NOT a failure — it is "zero rows". listAccounts must return [] so the
  // page can render an empty table instead of crashing on a filter miss.
  describe('#47g — empty-accounts_list (404) → [] not error (verified live 2026-06-11)', () => {
    const EMPTY_ACCOUNTS_404_BODY = {
      type: 'https://partners.gigaredsa.com.ar/errors/empty-accounts_list',
      title: 'Cuentas inexistentes',
      status: 404,
      detail: 'No hay cuentas que se correspondan con los filtros especificados',
    };

    it('listAccounts with a no-match filter → [] (empty-accounts_list is empty, not 404)', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(404, { data: EMPTY_ACCOUNTS_404_BODY }));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.listAccounts({ email: 'nobody@x.com' })).resolves.toEqual([]);
    });

    it('a GENUINE 404 (no empty-accounts_list type) on listAccounts still → GigaredNotFoundError', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(axiosError(404));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.listAccounts({ email: 'x@x.com' })).rejects.toBeInstanceOf(GigaredNotFoundError);
    });

    it('empty-accounts_list type does NOT swallow a lookup-by-internal-id 404 (still throws)', async () => {
      const http = makeHttp();
      // empty-accounts_list is list-only semantics; a single-account lookup that 404s with it
      // is degenerate, but listAccounts is the ONLY caller that treats it as empty.
      http.get.mockRejectedValue(axiosError(404, { data: EMPTY_ACCOUNTS_404_BODY }));
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getAccountByInternalId('CLIENTE_001')).rejects.toBeInstanceOf(GigaredNotFoundError);
    });
  });

  // ---- #47g — upstream diagnostics: console.warn on every non-NotFound error --------
  describe('#47g — upstream error diagnostics (console.warn)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('logs [gigared] upstream status/type/detail on a 5xx (unavailable)', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const http = makeHttp();
      http.get.mockRejectedValue(
        axiosError(503, { data: { type: 'https://partners.gigaredsa.com.ar/errors/x', detail: 'down hard' } }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredUnavailableError);
      expect(warn).toHaveBeenCalledWith(
        '[gigared] upstream',
        503,
        'https://partners.gigaredsa.com.ar/errors/x',
        'down hard',
      );
    });

    it('logs the upstream detail on a generic 424 (rejected/unavailable)', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const http = makeHttp();
      http.get.mockRejectedValue(
        axiosError(424, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/external-service-error',
            detail: 'El servicio CUA no respondió a tiempo',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredUnavailableError);
      expect(warn).toHaveBeenCalledWith(
        '[gigared] upstream',
        424,
        'https://partners.gigaredsa.com.ar/errors/external-service-error',
        'El servicio CUA no respondió a tiempo',
      );
    });

    it('does NOT warn on a not-found (the expected "this account does not exist")', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const http = makeHttp();
      http.get.mockRejectedValue(
        axiosError(424, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/external-service-error',
            detail: 'No se encontró una cuenta con internal_id abc',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getAccountByInternalId('abc')).rejects.toBeInstanceOf(GigaredNotFoundError);
      expect(warn).not.toHaveBeenCalled();
    });

    it('carries the upstream detail into GigaredUnavailableError on a generic 424', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(
        axiosError(424, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/external-service-error',
            detail: 'El servicio CUA no respondió a tiempo',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toMatchObject({
        code: 'GIGARED_UNAVAILABLE',
        detail: 'El servicio CUA no respondió a tiempo',
      });
    });

    it('carries the upstream detail into GigaredAuthError on a 401/403', async () => {
      const http = makeHttp();
      http.get.mockRejectedValue(
        axiosError(403, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/invalid-api-key',
            detail: 'La clave de API proporcionada no es válida',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.getSummary()).rejects.toMatchObject({
        code: 'GIGARED_AUTH_FAILED',
        detail: 'La clave de API proporcionada no es válida',
      });
    });
  });

  // ---- #47j — OTT status normalization + idempotent toggle (verified live 2026-06-11) -----
  // The LIVE Gigared API sends ott.status as Spanish free-text ("habilitado"/"deshabilitado",
  // also null) — NOT the docs' 'active'. The FE compared against 'active' and always showed the
  // toggle OFF even when the account was enabled; re-enabling then got rejected with
  // "La cuenta OTT ya se encuentra habilitada". Fix: normalize status to 'enabled'|'disabled'|null,
  // and treat an "already (dis/en)abled" partner rejection as success (the desired state holds).
  describe('#47j — mapOtt status normalization', () => {
    afterEach(() => jest.restoreAllMocks());

    const accountWith = (status: unknown) => ({
      message: 'Éxito',
      detail: {
        crm: {
          cic: '0000000001', gigared_id: '10000000100', email: null, first_name: null,
          last_name: null, registration_date: null, services: [],
        },
        internal_id: 'CLIENTE_001',
        ott: {
          id: 'GIGA10000000100', qty_stationary_licenses: 3, qty_mobile_licenses: 5,
          qty_registered_devices: 0, status,
        },
      },
    });

    it('"habilitado" → "enabled"', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWith('habilitado') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.ott!.status).toBe('enabled');
    });

    it('"deshabilitado" → "disabled"', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWith('deshabilitado') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.ott!.status).toBe('disabled');
    });

    it('null → null', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWith(null) });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.ott!.status).toBeNull();
    });

    it('tolerant: uppercase/whitespace " Habilitado " → "enabled"', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWith(' Habilitado ') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.ott!.status).toBe('enabled');
    });

    it('unrecognized non-empty string "raro" → null + console.warn', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWith('raro') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.ott!.status).toBeNull();
      expect(warn).toHaveBeenCalledWith('[gigared] unknown ott.status', 'raro');
    });
  });

  describe('#47j — setOtt idempotent toggle (partner "already (dis/en)abled" = success)', () => {
    it('setOtt(true) when partner rejects "ya se encuentra habilitada" → resolves (success)', async () => {
      const http = makeHttp();
      http.put.mockRejectedValue(
        axiosError(409, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/ott-state-error',
            title: 'Estado OTT inválido',
            status: 409,
            detail: 'La cuenta OTT ya se encuentra habilitada',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.setOtt('CLIENTE_001', true)).resolves.toBeUndefined();
    });

    it('setOtt(false) when partner rejects "ya se encuentra deshabilitada" → resolves (success)', async () => {
      const http = makeHttp();
      http.put.mockRejectedValue(
        axiosError(409, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/ott-state-error',
            title: 'Estado OTT inválido',
            status: 409,
            detail: 'La cuenta OTT ya se encuentra deshabilitada',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.setOtt('CLIENTE_001', false)).resolves.toBeUndefined();
    });

    it('a DIFFERENT partner rejection still propagates as an error (with detail)', async () => {
      const http = makeHttp();
      http.put.mockRejectedValue(
        axiosError(422, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/ott-error',
            title: 'Sin licencias',
            status: 422,
            detail: 'No hay licencias OTT disponibles',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.setOtt('CLIENTE_001', true)).rejects.toMatchObject({
        code: 'GIGARED_REJECTED',
        detail: 'No hay licencias OTT disponibles',
      });
    });

    // #1 — 424 external-service-error "ya se encuentra (des)habilitada" must be idempotent.
    // The partner returns 424 (external-service-error) for OTT state conflicts, NOT 409.
    // mapError maps 424/external-service-error → GigaredUnavailableError(detail). The old guard
    // only caught GigaredRejectedError, so this case fell through as an error. Fixed: broaden
    // catch to also swallow GigaredUnavailableError when detail matches the idempotency phrase.
    it('#1: setOtt(false) — partner sends 424 external-service-error "La cuenta OTT ya se encuentra deshabilitada" → resolves (idempotent success)', async () => {
      const http = makeHttp();
      http.put.mockRejectedValue(
        axiosError(424, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/external-service-error',
            title: 'Error en servicio externo',
            status: 424,
            detail: 'La cuenta OTT ya se encuentra deshabilitada',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.setOtt('CLIENTE_001', false)).resolves.toBeUndefined();
    });

    it('#1: setOtt(true) — partner sends 424 external-service-error "La cuenta OTT ya se encuentra habilitada" → resolves (idempotent success)', async () => {
      const http = makeHttp();
      http.put.mockRejectedValue(
        axiosError(424, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/external-service-error',
            title: 'Error en servicio externo',
            status: 424,
            detail: 'La cuenta OTT ya se encuentra habilitada',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.setOtt('CLIENTE_001', true)).resolves.toBeUndefined();
    });

    it('#1: 424 external-service-error with a DIFFERENT detail (genuine CUA outage) still throws GigaredUnavailableError', async () => {
      const http = makeHttp();
      http.put.mockRejectedValue(
        axiosError(424, {
          data: {
            type: 'https://partners.gigaredsa.com.ar/errors/external-service-error',
            title: 'Error en servicio externo',
            status: 424,
            detail: 'El servicio CUA no respondió a tiempo',
          },
        }),
      );
      const { client, ready } = makeClient(http);
      await ready;
      await expect(client.setOtt('CLIENTE_001', true)).rejects.toBeInstanceOf(GigaredUnavailableError);
    });
  });
});
