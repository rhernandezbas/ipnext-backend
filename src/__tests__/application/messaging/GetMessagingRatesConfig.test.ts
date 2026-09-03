/**
 * twilio-credit-guard (Batch 2, task 2.3, RATES-1) — `GetMessagingRatesConfig`.
 * Molde `GetExternalBulkConfig.test.ts`: delega íntegramente en el repo, los
 * defaults sin fila previa son responsabilidad DEL REPO (ya pineados en
 * `InMemoryMessagingRatesConfigRepository.test.ts`, B1).
 */
import { GetMessagingRatesConfig } from '@application/use-cases/messaging/GetMessagingRatesConfig';
import { InMemoryMessagingRatesConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryMessagingRatesConfigRepository';
import { MESSAGING_RATES_CONFIG_DEFAULTS } from '@domain/ports/MessagingRatesConfigRepository';

const NOW = new Date('2026-09-03T00:00:00.000Z');

describe('GetMessagingRatesConfig (RATES-1)', () => {
  it('sin fila previa devuelve los 5 defaults (delegado del repo)', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new GetMessagingRatesConfig(repo);

    const result = await useCase.execute();

    expect(result).toEqual({ ...MESSAGING_RATES_CONFIG_DEFAULTS, updatedAt: NOW.toISOString() });
  });

  it('tras un set() previo, devuelve la config persistida (no los defaults)', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    await repo.set({
      currency: 'USD',
      utilityRate: '0.0150',
      marketingRate: '0.0700',
      authenticationRate: '0.0250',
      providerFee: '0.0060',
    });
    const useCase = new GetMessagingRatesConfig(repo);

    const result = await useCase.execute();

    expect(result.utilityRate).toBe('0.0150');
    expect(result.marketingRate).toBe('0.0700');
  });
});
