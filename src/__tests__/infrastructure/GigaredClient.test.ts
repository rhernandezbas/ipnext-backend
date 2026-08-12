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
      expect(a.registrationDate).toBe('2026-01-19');
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

  /**
   * W4 — THROTTLE PREVENTIVO. Números MEDIDOS en vivo el 2026-08-10 contra
   * `partners.gigaredsa.com.ar`: 15 llamadas seguidas dieron `200×10` y después `429×5`
   * (o sea corta a las ~10 por ventana), con recuperación dentro de los 60 s, y SIN mandar
   * `Retry-After` ni `X-RateLimit-*` — no hay forma de negociar el límite, hay que
   * respetarlo desde acá.
   *
   * POR QUÉ PREVENTIVO Y NO UN BACKOFF REACTIVO. Un alta hace hasta 17 llamadas al partner
   * (probe + pool + MAX_CANDIDATOS × 5). Si el `activate` se come un 429 DESPUÉS de que el
   * `register` ya fue aceptado, del otro lado queda una activación pendiente y ese cliente
   * NO SE PUEDE DAR DE ALTA NUNCA MÁS. El daño es permanente, así que la única defensa
   * aceptable es no llegar nunca al 429.
   *
   * TODOS estos tests usan un reloj VIRTUAL que el `_sleep` AVANZA. Es deliberado y no es
   * ceremonia: con `Date.now()` real y un sleep instantáneo, un test da verde certificando
   * una espera que en producción no ocurre. Y la base del reloj es una fecha REAL, no
   * `1_000_000`: con un origen de juguete, restarle una hora manda el tiempo a negativo y
   * un test puede pasar por ese accidente en vez de por el código.
   */
  describe('W4 — throttle preventivo del rate limit del partner', () => {
    /** Base realista (no un origen de juguete): restarle una hora sigue siendo positivo. */
    const T0 = Date.UTC(2026, 7, 10, 15, 0, 0);

    /** Deja correr la cola de microtareas hasta que se asiente. */
    const asentar = async () => {
      for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    };

    /**
     * Simulador de eventos discretos con COLA CONCURRENTE. Ese es el ingrediente que le da
     * poder de detección, y conviene ser preciso sobre por qué: el reloj virtual secuencial de
     * más arriba corre una llamada por vez —cada una termina antes de que empiece la
     * siguiente—, así que nunca hay dos tandas dormidas solapándose y no puede expresar
     * ningún bug de rate REAL. Acá las llamadas duermen de verdad, en paralelo, y despiertan
     * por vencimiento.
     *
     * El `sleep` es MONOTÓNICO, igual que `setTimeout` en producción: lo ya dormido despierta
     * por tiempo transcurrido, no por fecha. Las emisiones se miden en `mono`, que es como
     * cuenta el partner.
     */
    function makeSimulador() {
      let mono = 0;
      let seq = 0;
      const pendientes: { t: number; seq: number; despertar: () => void }[] = [];
      return {
        monotonico: () => mono,
        sleep: (ms: number) =>
          new Promise<void>((despertar) => {
            pendientes.push({ t: mono + Math.max(0, ms), seq: seq++, despertar });
          }),
        get mono() {
          return mono;
        },
        async drenarHasta(terminado: () => boolean, limite = 5000) {
          let pasos = 0;
          await asentar();
          while (!terminado() && pasos++ < limite) {
            if (pendientes.length === 0) {
              await asentar();
              if (pendientes.length === 0) break;
              continue;
            }
            pendientes.sort((a, b) => a.t - b.t || a.seq - b.seq);
            const p = pendientes.shift() as { t: number; seq: number; despertar: () => void };
            if (p.t > mono) mono = p.t;
            p.despertar();
            await asentar();
          }
        },
      };
    }

    /** Máximo de emisiones en cualquier ventana deslizante de 60 s de tiempo REAL. */
    function maxPorVentana(emisiones: number[]): number {
      let peor = 0;
      for (const inicio of emisiones) {
        const n = emisiones.filter((t) => t >= inicio && t < inicio + 60_000).length;
        if (n > peor) peor = n;
      }
      return peor;
    }

    /** Reloj virtual: el `sleep` ADELANTA el tiempo, así el test mide lo que pasa en prod. */
    function makeRelojVirtual(inicio = T0) {
      let ahora = inicio;
      return {
        now: () => ahora,
        sleep: async (ms: number) => {
          ahora += ms;
        },
        get t() {
          return ahora;
        },
      };
    }

    function makeThrottledClient(
      http: ReturnType<typeof makeHttp>,
      opts: { reloj?: ReturnType<typeof makeRelojVirtual>; extra?: Record<string, unknown> } = {},
    ) {
      const reloj = opts.reloj ?? makeRelojVirtual();
      const cfg = new InMemoryGigaredConfigRepository();
      const ready = cfg.update({ apiKey: 'mykey1234' });
      const client = new GigaredClient({
        configProvider: cfg,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        http: http as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _sleep: reloj.sleep as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _now: reloj.now as any,
        ...(opts.extra ?? {}),
      });
      return { client, ready, reloj };
    }

    /**
     * EL TEST QUE EXPRESA EL INVARIANTE REAL: **conteo por ventana deslizante de 60 s,
     * medido DESDE FRÍO**.
     *
     * Desde frío importa: la ráfaga se SUMA a la ventana, no se amortigua contra ella. Un
     * test que gaste el burst antes de medir excluye justamente el tramo donde el invariante
     * se rompe — que es el tramo que corre un alta real sobre un cliente ocioso.
     */
    it('en NINGUNA ventana de 60 s salen más de 9 requests, medido DESDE FRÍO', async () => {
      const http = makeHttp();
      const salidas: number[] = [];
      const reloj = makeRelojVirtual();
      http.get.mockImplementation(async () => {
        salidas.push(reloj.t);
        return { data: SUMMARY_FIXTURE };
      });
      const { client, ready } = makeThrottledClient(http, { reloj });
      await ready;

      // 17 = el peor caso de un alta (probe + pool + MAX_CANDIDATOS × 5).
      for (let i = 0; i < 17; i++) await client.getSummary();

      expect(salidas).toHaveLength(17);
      for (const inicio of salidas) {
        const enVentana = salidas.filter((t) => t >= inicio && t < inicio + 60_000).length;
        // 9 y no 10: el límite MEDIDO es 10 y se midió UNA sola vez. Assertear `<= 10`
        // dejaría pasar `burst = 3`, que da EXACTAMENTE 10 — margen cero contra el número
        // donde el partner ya cortó. El margen es parte del diseño, así que se pinea acá.
        expect(enVentana).toBeLessThanOrEqual(9);
      }
    });

    it('una ráfaga corta (abrir un panel) no paga NINGUNA espera', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: SUMMARY_FIXTURE });
      const { client, ready, reloj } = makeThrottledClient(http);
      await ready;
      const antes = reloj.t;

      // La ráfaga es 2 y no puede ser más: el techo real es `límite − 60000/intervalo`.
      await client.getSummary();
      await client.getSummary();

      expect(reloj.t - antes).toBe(0);
      expect(http.get).toHaveBeenCalledTimes(2);
    });

    /**
     * Dos llamadas concurrentes tienen que llevarse turnos DISTINTOS. Si se llevaran el
     * mismo, se despertarían juntas y saldrían en ráfaga contra un partner que corta POR
     * CONTEO — que es exactamente lo que el throttle existe para evitar.
     */
    it('dos llamadas concurrentes reservan turnos DISTINTOS (sin thundering herd)', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: SUMMARY_FIXTURE });
      const esperas: number[] = [];
      const cfg = new InMemoryGigaredConfigRepository();
      await cfg.update({ apiKey: 'mykey1234' });
      const client = new GigaredClient({
        configProvider: cfg,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        http: http as any,
        // El reloj NO avanza acá a propósito: lo que se aísla es la RESERVA, no la espera.
        // Con el tiempo detenido, dos turnos tienen que salir a instantes distintos y
        // crecientes. El comportamiento temporal real lo cubre el test de la ventana.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _sleep: (async (ms: number) => {
          esperas.push(ms);
        }) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _now: (() => T0) as any,
        _burstCapacity: 1,
      });
      await client.getSummary(); // gasta el único turno inmediato

      esperas.length = 0;
      await Promise.all([client.getSummary(), client.getSummary()]);

      expect(esperas).toHaveLength(2);
      expect(new Set(esperas).size).toBe(2);
      // Y el segundo turno va DESPUÉS del primero: la marca sólo avanza.
      expect(Math.max(...esperas) - Math.min(...esperas)).toBe(7500);
    });

    /**
     * NO HAY TECHO DE ESPERA (fail-fast por saturación). Hubo uno y era un CRÍTICO: rechazaba
     * la llamada #9 DESPUÉS de que el `register` fuera aceptado, o sea quemaba al cliente
     * con nuestro propio throttle. Ahora el alta es asíncrona (job + polling), así que no
     * existe el `requestTimeout` que aquel techo protegía: la cola puede tomarse sus ~114 s.
     *
     * Reloj CONGELADO a propósito: es el PEOR caso, las 17 llamadas encoladas de una. Acá la
     * regla del reloj que avanza no aplica — lo que se afirma no es una espera (que un reloj
     * congelado podría falsear) sino que las 17 llamadas LLEGAN al partner.
     */
    it('un alta completa (17 llamadas) NUNCA es rechazada por el throttle', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: SUMMARY_FIXTURE });
      const cfg = new InMemoryGigaredConfigRepository();
      await cfg.update({ apiKey: 'mykey1234' });
      const client = new GigaredClient({
        configProvider: cfg,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        http: http as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _sleep: (async () => {}) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _now: (() => T0) as any,
      });

      for (let i = 0; i < 17; i++) await client.getSummary();

      expect(http.get).toHaveBeenCalledTimes(17);
    });

    /**
     * EL INVARIANTE BAJO COLA CONCURRENTE DORMIDA — el escenario que rompía todas las
     * versiones anteriores de este throttle.
     *
     * El ingrediente que lo hace capaz de cazar bugs es **la cola concurrente**: 12 llamadas
     * que reservan turno y se quedan dormidas, y otras 12 que llegan mientras la primera
     * tanda todavía duerme. El reloj virtual SECUENCIAL de los tests de arriba no puede
     * expresarlo —cada llamada termina antes de que empiece la siguiente, así que nunca hay
     * dos calendarios que solapar—, y por eso dejaba pasar bugs de rate real.
     *
     * Las emisiones se miden en tiempo MONOTÓNICO, que es como cuenta el partner.
     */
    it('sostiene el invariante ≤9 con cola concurrente dormida', async () => {
      const http = makeHttp();
      const sim = makeSimulador();
      const emisiones: number[] = [];
      http.get.mockImplementation(async () => {
        emisiones.push(sim.mono);
        return { data: SUMMARY_FIXTURE };
      });
      const cfg = new InMemoryGigaredConfigRepository();
      await cfg.update({ apiKey: 'mykey1234' });
      const client = new GigaredClient({
        configProvider: cfg,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        http: http as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _sleep: sim.sleep as any,
        // Monotónico, igual que producción.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _now: sim.monotonico as any,
      });

      const enVuelo: Promise<unknown>[] = [];
      for (let i = 0; i < 12; i++) enVuelo.push(client.getSummary());
      await asentar();
      // Segunda tanda con la primera TODAVÍA dormida.
      for (let i = 0; i < 12; i++) enVuelo.push(client.getSummary());

      await sim.drenarHasta(() => emisiones.length >= 24);
      await Promise.all(enVuelo);

      expect(emisiones).toHaveLength(24);
      expect(maxPorVentana(emisiones)).toBeLessThanOrEqual(9);
    });

    /**
     * EL RELOJ POR DEFECTO TIENE QUE SER MONOTÓNICO. Este test existe porque TODOS los demás
     * inyectan `_now`, así que ninguno puede ver cuál es el reloj real de producción: volver
     * el default a `Date.now` los deja a todos en verde. Es el caso de libro de "la función
     * que decide no es la que se testea".
     *
     * Y no es cosmético. Con `Date.now`, un salto de NTP hacia ADELANTE es indistinguible del
     * ocio: `Math.max(ahora - crédito, marca)` regala la ráfaga y re-basa el calendario
     * mientras la cola dormida sigue despertando en tiempo monotónico. Medido con cola
     * concurrente: +10 s → 10 req/ventana, +60 s → 16, +1 h → 18, contra un límite de 10.
     */
    it('usa un reloj MONOTÓNICO por defecto, no el de pared', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: SUMMARY_FIXTURE });
      const cfg = new InMemoryGigaredConfigRepository();
      await cfg.update({ apiKey: 'mykey1234' });
      const espiaPerf = jest.spyOn(performance, 'now');
      const espiaDate = jest.spyOn(Date, 'now');
      try {
        // SIN `_now`: se ejercita el default, que es lo que corre en producción.
        const client = new GigaredClient({
          configProvider: cfg,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          http: http as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          _sleep: (async () => {}) as any,
        });
        espiaPerf.mockClear();
        espiaDate.mockClear();
        await client.getSummary();

        expect(espiaPerf).toHaveBeenCalled();
        expect(espiaDate).not.toHaveBeenCalled();
      } finally {
        espiaPerf.mockRestore();
        espiaDate.mockRestore();
      }
    });

    /**
     * EL GUARDA DE UNA GARANTÍA QUE EL COMENTARIO PROMETE Y NINGÚN TEST PROTEGÍA: el turno se
     * reserva TAMBIÉN en cada reintento, no sólo en el primer intento.
     *
     * Es la rama que corre justamente cuando el throttle preventivo YA falló —o sea cuando el
     * partner ya está cortando— y es donde un reintento sin turno multiplica el daño en vez de
     * contenerlo. Sin este test, mutar `await this.reservarTurno()` a
     * `if (attempt === 0) await this.reservarTurno()` sobrevive la suite entera.
     */
    it('reserva turno TAMBIÉN en los reintentos del 429, no sólo en el primer intento', async () => {
      const http = makeHttp();
      const sim = makeSimulador();
      const emisiones: number[] = [];
      http.get.mockImplementation(async () => {
        emisiones.push(sim.mono);
        throw axiosError(429);
      });
      const cfg = new InMemoryGigaredConfigRepository();
      await cfg.update({ apiKey: 'mykey1234' });
      const client = new GigaredClient({
        configProvider: cfg,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        http: http as any,
        maxRateLimitRetries: 10,
        // Backoff mínimo a propósito: si el espaciado saliera del backoff en vez del turno,
        // el test no probaría nada. Con 1 ms, lo único que puede espaciar es el throttle.
        backoffMs: 1,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _sleep: sim.sleep as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _now: sim.monotonico as any,
      });

      let fallo: unknown;
      const p = client.getSummary().catch((e) => {
        fallo = e;
      });
      await sim.drenarHasta(() => emisiones.length >= 11);
      await p;

      expect(fallo).toBeInstanceOf(GigaredUnavailableError);
      expect(emisiones).toHaveLength(11); // intento inicial + 10 reintentos
      expect(maxPorVentana(emisiones)).toBeLessThanOrEqual(9);
    });

    it('clampea un Retry-After absurdo a 60 s', async () => {
      const http = makeHttp();
      // El partner no manda Retry-After, pero un WAF/CDN intermedio puede inyectarlo. Sin
      // tope, `Retry-After: 3600` dormía UNA HORA en un cliente que es singleton.
      http.get.mockRejectedValue(axiosError(429, { headers: { 'retry-after': '3600' } }));
      const dormido: number[] = [];
      const reloj = makeRelojVirtual();
      const cfg = new InMemoryGigaredConfigRepository();
      await cfg.update({ apiKey: 'mykey1234' });
      const client = new GigaredClient({
        configProvider: cfg,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        http: http as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _sleep: (async (ms: number) => {
          dormido.push(ms);
          await reloj.sleep(ms);
        }) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _now: reloj.now as any,
      });

      await expect(client.getSummary()).rejects.toBeInstanceOf(GigaredUnavailableError);

      // Hubo backoffs reales (si no, esto asertaría sobre una lista vacía y pasaría siempre).
      expect(dormido.length).toBeGreaterThan(0);
      for (const ms of dormido) expect(ms).toBeLessThanOrEqual(60_000);
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

  // ---- #2 — normalizeRegistrationDate: DD/MM/YYYY → ISO YYYY-MM-DD --------
  describe('#2 — normalizeRegistrationDate (DD/MM/YYYY → ISO)', () => {
    const accountWithDate = (registration_date: string | null) => ({
      message: 'Éxito',
      detail: {
        crm: {
          cic: '0000000001', gigared_id: '10000000100', email: null,
          first_name: null, last_name: null, registration_date,
          services: [],
        },
        internal_id: 'CLIENTE_001',
        ott: null,
      },
    });

    it('"19/01/2026" → "2026-01-19"', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWithDate('19/01/2026') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.registrationDate).toBe('2026-01-19');
    });

    it('null → null', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWithDate(null) });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.registrationDate).toBeNull();
    });

    it('"" (empty string) → null', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWithDate('') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.registrationDate).toBeNull();
    });

    it('"garbage-date" → null', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWithDate('not-a-date') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.registrationDate).toBeNull();
    });

    it('already-ISO "2026-01-19" passes through unchanged', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWithDate('2026-01-19') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('CLIENTE_001');
      expect(a.registrationDate).toBe('2026-01-19');
    });
  });

  // ---- #3 — clientId: derived from internalId by stripping trailing -{seq} --------
  describe('#3 — clientId derived from internalId', () => {
    const accountWithInternalId = (internal_id: string | null) => ({
      message: 'Éxito',
      detail: {
        crm: {
          cic: '0000000001', gigared_id: '10000000100', email: null,
          first_name: null, last_name: null, registration_date: null,
          services: [],
        },
        internal_id,
        ott: null,
      },
    });

    it('"uuid-1" → clientId "uuid"', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWithInternalId('uuid-1') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('uuid-1');
      expect(a.clientId).toBe('uuid');
    });

    it('bare "uuid" (no suffix) → clientId "uuid"', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWithInternalId('uuid') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('uuid');
      expect(a.clientId).toBe('uuid');
    });

    it('null internalId → null clientId', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWithInternalId(null) });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('uuid');
      expect(a.clientId).toBeNull();
    });

    it('"real-uuid-0" → clientId "real-uuid" (UUID with embedded hyphens)', async () => {
      const http = makeHttp();
      http.get.mockResolvedValue({ data: accountWithInternalId('550e8400-e29b-41d4-a716-446655440000-2') });
      const { client, ready } = makeClient(http);
      await ready;
      const a = await client.getAccountByInternalId('550e8400-e29b-41d4-a716-446655440000-2');
      expect(a.clientId).toBe('550e8400-e29b-41d4-a716-446655440000');
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
