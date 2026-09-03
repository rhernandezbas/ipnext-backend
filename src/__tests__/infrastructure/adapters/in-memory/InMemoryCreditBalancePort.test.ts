/**
 * twilio-credit-guard (1.6) — InMemoryCreditBalancePort. Fake settable para
 * tests de use cases (`ValidateExternalBulk`/`SendExternalBulk`), NUNCA mockear
 * axios real. `calls` pinea "una sola request"/"replay no llama getBalance()"
 * (CG-SEND-4) en B3.
 */
import { InMemoryCreditBalancePort } from '@infrastructure/adapters/in-memory/InMemoryCreditBalancePort';
import { CreditUnavailableError } from '@domain/errors/external-bulk-messaging';

describe('InMemoryCreditBalancePort', () => {
  it('defaults: amount 17.8940 USD, cached false', async () => {
    const port = new InMemoryCreditBalancePort();

    const balance = await port.getBalance();

    expect(balance.amount).toBe('17.8940');
    expect(balance.currency).toBe('USD');
    expect(balance.cached).toBe(false);
    expect(balance.fetchedAt).toBeInstanceOf(Date);
  });

  it('amount/currency/fetchedAt son seteables', async () => {
    const fetchedAt = new Date('2026-09-03T00:00:00.000Z');
    const port = new InMemoryCreditBalancePort({ amount: '5.0000', currency: 'ARS', fetchedAt });

    const balance = await port.getBalance();

    expect(balance.amount).toBe('5.0000');
    expect(balance.currency).toBe('ARS');
    expect(balance.fetchedAt).toBe(fetchedAt);
  });

  it('failNext=true ⇒ tira CreditUnavailableError', async () => {
    const port = new InMemoryCreditBalancePort();
    port.failNext = true;

    await expect(port.getBalance()).rejects.toBeInstanceOf(CreditUnavailableError);
  });

  it('contador público calls cuenta cada invocación de getBalance()', async () => {
    const port = new InMemoryCreditBalancePort();

    expect(port.calls).toBe(0);
    await port.getBalance();
    expect(port.calls).toBe(1);
    await port.getBalance();
    expect(port.calls).toBe(2);
  });

  it('calls también cuenta cuando falla (failNext)', async () => {
    const port = new InMemoryCreditBalancePort();
    port.failNext = true;

    await expect(port.getBalance()).rejects.toThrow();
    expect(port.calls).toBe(1);
  });
});

/**
 * fix wave F1 (F2) — PARIDAD campo-a-campo con `TwilioCreditBalanceGateway`:
 * cache single-slot con TTL 60s y reloj inyectable, `cached` REAL, bypass
 * `{fresh:true}`, `invalidate()`, y un contador de LECTURAS de origen
 * (`fetches`, el equivalente al `http.get` del gateway). Sin esto el drenaje
 * de saldo entre `validate` y `send` (F1) no es testeable con el twin.
 */
describe('InMemoryCreditBalancePort — paridad de cache con el gateway (fix wave F1, F2)', () => {
  it('2 llamadas dentro de 60s ⇒ 1 sola lectura de origen + cached:true en la 2ª', async () => {
    let now = 1_000_000;
    const port = new InMemoryCreditBalancePort({ amount: '10.0000', now: () => now });

    const first = await port.getBalance();
    now += 30_000;
    const second = await port.getBalance();

    expect(port.fetches).toBe(1);
    expect(port.calls).toBe(2);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });

  it('la cache sirve el valor VIEJO aunque `amount` haya cambiado (el drenaje que F1 describe)', async () => {
    let now = 1_000_000;
    const port = new InMemoryCreditBalancePort({ amount: '10.0000', now: () => now });

    await port.getBalance();
    port.amount = '0.0000';
    now += 30_000;
    const cached = await port.getBalance();

    expect(cached.amount).toBe('10.0000');
    expect(cached.cached).toBe(true);
  });

  it('reloj +60_001ms ⇒ nueva lectura de origen (TTL vencido)', async () => {
    let now = 1_000_000;
    const port = new InMemoryCreditBalancePort({ amount: '10.0000', now: () => now });

    await port.getBalance();
    port.amount = '20.0000';
    now += 60_001;
    const second = await port.getBalance();

    expect(port.fetches).toBe(2);
    expect(second.cached).toBe(false);
    expect(second.amount).toBe('20.0000');
  });

  it('getBalance({fresh:true}) IGNORA la cache vigente y devuelve el valor ACTUAL', async () => {
    let now = 1_000_000;
    const port = new InMemoryCreditBalancePort({ amount: '10.0000', now: () => now });

    await port.getBalance();
    port.amount = '0.0000';
    now += 30_000;
    const fresh = await port.getBalance({ fresh: true });

    expect(port.fetches).toBe(2);
    expect(fresh.cached).toBe(false);
    expect(fresh.amount).toBe('0.0000');
  });

  it('un fresh REFRESCA la cache: la siguiente lectura normal sirve el valor NUEVO', async () => {
    let now = 1_000_000;
    const port = new InMemoryCreditBalancePort({ amount: '10.0000', now: () => now });

    await port.getBalance();
    port.amount = '0.0000';
    await port.getBalance({ fresh: true });
    const third = await port.getBalance();

    expect(port.fetches).toBe(2);
    expect(third.cached).toBe(true);
    expect(third.amount).toBe('0.0000');
  });

  it('invalidate() vacía el slot ⇒ la siguiente lectura normal vuelve al origen', async () => {
    let now = 1_000_000;
    const port = new InMemoryCreditBalancePort({ amount: '10.0000', now: () => now });

    await port.getBalance();
    port.invalidate();
    port.amount = '2.0000';
    const second = await port.getBalance();

    expect(port.fetches).toBe(2);
    expect(second.cached).toBe(false);
    expect(second.amount).toBe('2.0000');
  });

  it('el error NUNCA se cachea (paridad con el gateway)', async () => {
    const port = new InMemoryCreditBalancePort({ amount: '10.0000' });
    port.failNext = true;

    await expect(port.getBalance()).rejects.toBeInstanceOf(CreditUnavailableError);
    port.failNext = false;
    const second = await port.getBalance();

    expect(port.fetches).toBe(2);
    expect(second.cached).toBe(false);
    expect(second.amount).toBe('10.0000');
  });
});
