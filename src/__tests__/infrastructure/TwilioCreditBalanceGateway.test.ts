/**
 * twilio-credit-guard (1.8/1.9, D3.c) — TwilioCreditBalanceGateway. Patrón
 * axios de `TwilioContentGateway`/`SmartOltHttpGateway` (`http` inyectable, NUNCA
 * axios/nock real — un stub mínimo `{get: jest.fn()}`). Clase propia, NO extiende
 * `TwilioContentGateway`. Pinea: parseo del body REAL de prod, mapeo TODO-a-
 * `CreditUnavailableError`, cache single-slot TTL 60s con reloj inyectable, el
 * error NUNCA se cachea, URL + Basic auth exactos.
 */
import { TwilioCreditBalanceGateway } from '@infrastructure/adapters/twilio/TwilioCreditBalanceGateway';
import { CreditUnavailableError } from '@domain/errors/external-bulk-messaging';

function axiosErr(status?: number, opts: { code?: string; data?: unknown } = {}) {
  return {
    isAxiosError: true,
    message: status ? `Request failed with status code ${status}` : 'network error',
    code: opts.code,
    response: status === undefined ? undefined : { status, headers: {}, data: opts.data },
  };
}

function makeGateway(overrides: { get?: jest.Mock; now?: () => number } = {}) {
  const get = overrides.get ?? jest.fn();
  const gateway = new TwilioCreditBalanceGateway({
    accountSid: 'ACtest',
    authToken: 'secret',
    http: { get } as never,
    now: overrides.now,
  });
  return { gateway, get };
}

describe('TwilioCreditBalanceGateway — getBalance (parseo BAL-1/BAL-2)', () => {
  it("200 con el body REAL de prod ({\"balance\":\"17.894\",\"currency\":\"USD\"}) → amount '17.8940', cached:false", async () => {
    const { gateway, get } = makeGateway({
      get: jest.fn().mockResolvedValueOnce({ data: { balance: '17.894', currency: 'USD', account_sid: 'ACtest' } }),
    });

    const balance = await gateway.getBalance();

    expect(balance.amount).toBe('17.8940');
    expect(balance.currency).toBe('USD');
    expect(balance.cached).toBe(false);
    expect(balance.fetchedAt).toBeInstanceOf(Date);
  });

  it('normaliza currency a MAYÚSCULAS trimeada', async () => {
    const { gateway } = makeGateway({
      get: jest.fn().mockResolvedValueOnce({ data: { balance: '5', currency: ' usd ' } }),
    });

    const balance = await gateway.getBalance();

    expect(balance.currency).toBe('USD');
  });
});

describe('TwilioCreditBalanceGateway — URL exacta + Basic auth (D3.c)', () => {
  it('URL = {apiBaseUrl}/2010-04-01/Accounts/{accountSid}/Balance.json + Basic auth {username, password}', async () => {
    const { gateway, get } = makeGateway({
      get: jest.fn().mockResolvedValueOnce({ data: { balance: '17.894', currency: 'USD' } }),
    });

    await gateway.getBalance();

    expect(get).toHaveBeenCalledTimes(1);
    const [url, config] = get.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/Balance.json');
    expect((config as { auth: { username: string; password: string } }).auth).toEqual({
      username: 'ACtest',
      password: 'secret',
    });
  });

  it('respeta un apiBaseUrl inyectado (test override)', async () => {
    const get = jest.fn().mockResolvedValueOnce({ data: { balance: '1', currency: 'USD' } });
    const gateway = new TwilioCreditBalanceGateway({
      accountSid: 'ACtest',
      authToken: 'secret',
      apiBaseUrl: 'https://staging.twilio.test',
      http: { get } as never,
    });

    await gateway.getBalance();

    expect(get.mock.calls[0][0]).toBe('https://staging.twilio.test/2010-04-01/Accounts/ACtest/Balance.json');
  });
});

describe('TwilioCreditBalanceGateway — TODO mapea a CreditUnavailableError (BAL-4)', () => {
  it.each([401, 403, 404, 429, 500])('status %i → CreditUnavailableError', async (status) => {
    const { gateway } = makeGateway({ get: jest.fn().mockRejectedValueOnce(axiosErr(status)) });

    await expect(gateway.getBalance()).rejects.toBeInstanceOf(CreditUnavailableError);
  });

  it('timeout (ECONNABORTED, sin response) → CreditUnavailableError', async () => {
    const { gateway } = makeGateway({ get: jest.fn().mockRejectedValueOnce(axiosErr(undefined, { code: 'ECONNABORTED' })) });

    await expect(gateway.getBalance()).rejects.toBeInstanceOf(CreditUnavailableError);
  });

  it('error de red (sin isAxiosError) → CreditUnavailableError', async () => {
    const { gateway } = makeGateway({ get: jest.fn().mockRejectedValueOnce(new Error('ENOTFOUND')) });

    await expect(gateway.getBalance()).rejects.toBeInstanceOf(CreditUnavailableError);
  });

  it('JSON basura (data no es un objeto con balance) → CreditUnavailableError', async () => {
    const { gateway } = makeGateway({ get: jest.fn().mockResolvedValueOnce({ data: 'not json' }) });

    await expect(gateway.getBalance()).rejects.toBeInstanceOf(CreditUnavailableError);
  });

  it("balance:'abc' (no parseable) → CreditUnavailableError", async () => {
    const { gateway } = makeGateway({ get: jest.fn().mockResolvedValueOnce({ data: { balance: 'abc', currency: 'USD' } }) });

    await expect(gateway.getBalance()).rejects.toBeInstanceOf(CreditUnavailableError);
  });

  it("currency vacía → CreditUnavailableError", async () => {
    const { gateway } = makeGateway({ get: jest.fn().mockResolvedValueOnce({ data: { balance: '17.894', currency: '' } }) });

    await expect(gateway.getBalance()).rejects.toBeInstanceOf(CreditUnavailableError);
  });
});

describe('TwilioCreditBalanceGateway — cache single-slot TTL 60s (BAL-3, reloj inyectable)', () => {
  it('2 llamadas dentro de 60s ⇒ 1 sola request HTTP + cached:true en la 2ª', async () => {
    let now = 1_000_000;
    const get = jest.fn().mockResolvedValueOnce({ data: { balance: '17.894', currency: 'USD' } });
    const { gateway } = makeGateway({ get, now: () => now });

    const first = await gateway.getBalance();
    now += 30_000; // dentro de la ventana de 60s
    const second = await gateway.getBalance();

    expect(get).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.amount).toBe('17.8940');
  });

  it('reloj +60_001ms ⇒ dispara una 2ª request (TTL vencido)', async () => {
    let now = 1_000_000;
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: { balance: '17.894', currency: 'USD' } })
      .mockResolvedValueOnce({ data: { balance: '20.000', currency: 'USD' } });
    const { gateway } = makeGateway({ get, now: () => now });

    await gateway.getBalance();
    now += 60_001;
    const second = await gateway.getBalance();

    expect(get).toHaveBeenCalledTimes(2);
    expect(second.cached).toBe(false);
    expect(second.amount).toBe('20.0000');
  });

  it('el error NO se cachea: falla, luego éxito ⇒ 2 requests', async () => {
    const get = jest
      .fn()
      .mockRejectedValueOnce(axiosErr(500))
      .mockResolvedValueOnce({ data: { balance: '17.894', currency: 'USD' } });
    const { gateway } = makeGateway({ get });

    await expect(gateway.getBalance()).rejects.toBeInstanceOf(CreditUnavailableError);
    const second = await gateway.getBalance();

    expect(get).toHaveBeenCalledTimes(2);
    expect(second.cached).toBe(false);
    expect(second.amount).toBe('17.8940');
  });
});

/**
 * fix wave F1 (F1) — `getBalance({fresh:true})` + `invalidate()`. El gate del
 * `send` NO puede comparar contra un saldo PRE-gasto servido por la cache de
 * 60s que llenó el `validate` de hace 30 segundos.
 */
describe('TwilioCreditBalanceGateway — fresh bypass + invalidate (fix wave F1)', () => {
  it('getBalance({fresh:true}) IGNORA la cache vigente ⇒ 2ª request HTTP, cached:false', async () => {
    let now = 1_000_000;
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: { balance: '10.000', currency: 'USD' } })
      .mockResolvedValueOnce({ data: { balance: '0.000', currency: 'USD' } });
    const { gateway } = makeGateway({ get, now: () => now });

    const first = await gateway.getBalance();
    now += 30_000; // cache TODAVÍA vigente
    const second = await gateway.getBalance({ fresh: true });

    expect(get).toHaveBeenCalledTimes(2);
    expect(first.amount).toBe('10.0000');
    expect(second.cached).toBe(false);
    expect(second.amount).toBe('0.0000');
  });

  it('un fresh REFRESCA la cache: la siguiente lectura normal sirve el valor NUEVO', async () => {
    let now = 1_000_000;
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: { balance: '10.000', currency: 'USD' } })
      .mockResolvedValueOnce({ data: { balance: '0.000', currency: 'USD' } });
    const { gateway } = makeGateway({ get, now: () => now });

    await gateway.getBalance();
    now += 1_000;
    await gateway.getBalance({ fresh: true });
    const third = await gateway.getBalance();

    expect(get).toHaveBeenCalledTimes(2);
    expect(third.cached).toBe(true);
    expect(third.amount).toBe('0.0000');
  });

  it('un fresh que FALLA no deja la cache vieja pisada por basura, pero tampoco cachea el error', async () => {
    let now = 1_000_000;
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: { balance: '10.000', currency: 'USD' } })
      .mockRejectedValueOnce(axiosErr(500))
      .mockResolvedValueOnce({ data: { balance: '3.000', currency: 'USD' } });
    const { gateway } = makeGateway({ get, now: () => now });

    await gateway.getBalance();
    await expect(gateway.getBalance({ fresh: true })).rejects.toBeInstanceOf(CreditUnavailableError);
    const third = await gateway.getBalance({ fresh: true });

    expect(get).toHaveBeenCalledTimes(3);
    expect(third.amount).toBe('3.0000');
  });

  it('invalidate() vacía el slot ⇒ la siguiente lectura normal vuelve a pegarle a Twilio', async () => {
    let now = 1_000_000;
    const get = jest
      .fn()
      .mockResolvedValueOnce({ data: { balance: '10.000', currency: 'USD' } })
      .mockResolvedValueOnce({ data: { balance: '2.000', currency: 'USD' } });
    const { gateway } = makeGateway({ get, now: () => now });

    await gateway.getBalance();
    gateway.invalidate();
    now += 1_000; // TTL seguiría vigente si el slot no se hubiera vaciado
    const second = await gateway.getBalance();

    expect(get).toHaveBeenCalledTimes(2);
    expect(second.cached).toBe(false);
    expect(second.amount).toBe('2.0000');
  });
});
