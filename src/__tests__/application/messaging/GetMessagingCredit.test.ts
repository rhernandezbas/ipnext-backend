/**
 * twilio-credit-guard (Batch 2, D4.d) — `GetMessagingCredit`. Alimenta
 * `GET /credit` (B3) y la card FE (`GET /config/rates/balance`, B3). Combina
 * `creditPort.getBalance()` + `ratesRepo.get()`. A diferencia de
 * `ValidateExternalBulk` (advisory), acá un balance inalcanzable SÍ es un
 * error — es lo único que este endpoint devuelve (CRED-1/CRED-2).
 */
import { GetMessagingCredit } from '@application/use-cases/messaging/GetMessagingCredit';
import { InMemoryCreditBalancePort } from '@infrastructure/adapters/in-memory/InMemoryCreditBalancePort';
import { InMemoryMessagingRatesConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryMessagingRatesConfigRepository';
import { CreditUnavailableError } from '@domain/errors/external-bulk-messaging';

const NOW = new Date('2026-09-03T12:00:00.000Z');

describe('GetMessagingCredit (CRED-1/CRED-2)', () => {
  it('combina balance + tarifas vigentes en un solo shape', async () => {
    const creditPort = new InMemoryCreditBalancePort({ amount: '17.8940', currency: 'USD', fetchedAt: NOW });
    const ratesRepo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new GetMessagingCredit(creditPort, ratesRepo);

    const result = await useCase.execute();

    expect(result).toEqual({
      available: '17.8940',
      currency: 'USD',
      fetchedAt: NOW.toISOString(),
      cached: false,
      rates: {
        currency: 'USD',
        utilityRate: '0.0120',
        marketingRate: '0.0618',
        authenticationRate: '0.0220',
        providerFee: '0.0050',
        updatedAt: NOW.toISOString(),
      },
    });
  });

  /**
   * fix wave F1 (F2) — el twin ya no tiene un `cachedNext` decorativo: tiene
   * cache REAL. `cached:true` se GANA sirviendo del slot, igual que en
   * `TwilioCreditBalanceGateway`. Y `GET /credit` es ADVISORY: usa la cache
   * (no pide `fresh`) — el que exige saldo fresco es el gate del `send`.
   */
  it('cached:true cuando el port sirvió del slot de cache (2ª lectura dentro del TTL)', async () => {
    const creditPort = new InMemoryCreditBalancePort({ now: () => NOW.getTime() });
    const ratesRepo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new GetMessagingCredit(creditPort, ratesRepo);

    const first = await useCase.execute();
    const second = await useCase.execute();

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(creditPort.fetches).toBe(1);
  });

  it('getBalance() lanza ⇒ propaga CreditUnavailableError (acá SÍ es un error)', async () => {
    const creditPort = new InMemoryCreditBalancePort({ failNext: true });
    const ratesRepo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new GetMessagingCredit(creditPort, ratesRepo);

    await expect(useCase.execute()).rejects.toThrow(CreditUnavailableError);
  });
});
