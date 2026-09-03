/**
 * twilio-credit-guard (1.6) — InMemoryMessagingRatesConfigRepository. Molde
 * `InMemoryExternalBulkMessagingConfigRepository`. RATES-1: defaults sin fila
 * previa; `set()` persiste y `get()` posterior refleja el patch + `updatedAt`
 * actualizado.
 */
import { InMemoryMessagingRatesConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryMessagingRatesConfigRepository';

describe('InMemoryMessagingRatesConfigRepository', () => {
  it('get() sin fila previa devuelve los 5 defaults (RATES-1)', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository();

    const config = await repo.get();

    expect(config.currency).toBe('USD');
    expect(config.utilityRate).toBe('0.0120');
    expect(config.marketingRate).toBe('0.0618');
    expect(config.authenticationRate).toBe('0.0220');
    expect(config.providerFee).toBe('0.0050');
    expect(config.updatedAt).toEqual(expect.any(String));
  });

  it('set() persiste el patch; get() posterior lo refleja + updatedAt es un timestamp real seteado por el set()', async () => {
    const fixedNow = new Date('2026-09-03T12:00:00.000Z');
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => fixedNow });

    const updated = await repo.set({
      currency: 'USD',
      utilityRate: '0.0150',
      marketingRate: '0.0700',
      authenticationRate: '0.0250',
      providerFee: '0.0060',
    });
    const after = await repo.get();

    expect(updated.utilityRate).toBe('0.0150');
    expect(after.utilityRate).toBe('0.0150');
    expect(after.marketingRate).toBe('0.0700');
    expect(after.authenticationRate).toBe('0.0250');
    expect(after.providerFee).toBe('0.0060');
    expect(after.updatedAt).toBe(fixedNow.toISOString());
  });

  it('set() sucesivos pisan el patch anterior (último gana, fila única)', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository();

    await repo.set({
      currency: 'USD',
      utilityRate: '0.0150',
      marketingRate: '0.0700',
      authenticationRate: '0.0250',
      providerFee: '0.0060',
    });
    await repo.set({
      currency: 'ARS',
      utilityRate: '0.0100',
      marketingRate: '0.0500',
      authenticationRate: '0.0200',
      providerFee: '0.0040',
    });
    const after = await repo.get();

    expect(after.currency).toBe('ARS');
    expect(after.utilityRate).toBe('0.0100');
  });
});
