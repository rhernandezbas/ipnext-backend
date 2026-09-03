/**
 * twilio-credit-guard (Batch 2, task 2.3, RATES-2) — `SetMessagingRatesConfig`.
 * Molde `SetExternalBulkConfig.test.ts`: inputs `unknown` a propósito (última
 * barrera de tipo antes del repo), rechazo NO persiste, normaliza a 4
 * decimales con `formatMoney(parseMoney(x))` antes de escribir.
 */
import { SetMessagingRatesConfig, SetMessagingRatesConfigInput } from '@application/use-cases/messaging/SetMessagingRatesConfig';
import { InMemoryMessagingRatesConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryMessagingRatesConfigRepository';
import { ExternalBulkValidationError } from '@domain/errors/external-bulk-messaging';

const NOW = new Date('2026-09-03T00:00:00.000Z');

function validPatch(overrides: Record<string, unknown> = {}): SetMessagingRatesConfigInput {
  return {
    currency: 'USD',
    utilityRate: '0.0150',
    marketingRate: '0.0700',
    authenticationRate: '0.0250',
    providerFee: '0.0060',
    ...overrides,
  };
}

describe('SetMessagingRatesConfig (RATES-2)', () => {
  it('persiste un update válido y get() posterior lo refleja', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    const result = await useCase.execute(validPatch());

    expect(result.utilityRate).toBe('0.0150');
    expect(result.currency).toBe('USD');
    const after = await repo.get();
    expect(after.utilityRate).toBe('0.0150');
  });

  it('normaliza a 4 decimales (formatMoney(parseMoney(x))) antes de persistir', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    const result = await useCase.execute(validPatch({ utilityRate: '0.015' }));

    expect(result.utilityRate).toBe('0.0150');
  });

  it('tarifa negativa → 400 VALIDATION_ERROR, no persiste', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    await expect(useCase.execute(validPatch({ utilityRate: '-0.01' }))).rejects.toThrow(
      ExternalBulkValidationError,
    );
    const after = await repo.get();
    expect(after.utilityRate).toBe('0.0120'); // default intacto
  });

  it('tarifa con más de 4 decimales → 400 VALIDATION_ERROR', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    await expect(useCase.execute(validPatch({ marketingRate: '0.06185' }))).rejects.toThrow(
      ExternalBulkValidationError,
    );
  });

  it('tarifa como number (no string) → 400 VALIDATION_ERROR', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    await expect(useCase.execute(validPatch({ utilityRate: 0.012 }))).rejects.toThrow(
      ExternalBulkValidationError,
    );
  });

  it('currency minúscula ("usd") → 400 VALIDATION_ERROR', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    await expect(useCase.execute(validPatch({ currency: 'usd' }))).rejects.toThrow(
      ExternalBulkValidationError,
    );
  });

  it('currency con 4 letras ("USDD") → 400 VALIDATION_ERROR', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    await expect(useCase.execute(validPatch({ currency: 'USDD' }))).rejects.toThrow(
      ExternalBulkValidationError,
    );
    const after = await repo.get();
    expect(after.currency).toBe('USD'); // default intacto — no se persistió
  });

  it('notación exponencial ("1e-2") → 400 VALIDATION_ERROR', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    await expect(useCase.execute(validPatch({ providerFee: '1e-2' }))).rejects.toThrow(
      ExternalBulkValidationError,
    );
  });
});

/**
 * fix wave F1 (F6) — la columna es `DECIMAL(10,4)`: máximo 999999.9999. Un
 * valor mayor pasaba la regex, llegaba a Prisma y reventaba con un 500 sin
 * mensaje útil para el FE (o, peor, `parseMoney` tiraba `MoneyParseError`, que
 * NO es un `DomainError` ⇒ 500). Ahora es un 400 tipado, con mensaje mostrable.
 */
describe('SetMessagingRatesConfig — tope de la columna DECIMAL(10,4) (fix wave F1, F6)', () => {
  it.each(['utilityRate', 'marketingRate', 'authenticationRate', 'providerFee'])(
    '%s = "1000000" (7 dígitos de parte entera) ⇒ ExternalBulkValidationError, NO persiste',
    async (field) => {
      const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
      const useCase = new SetMessagingRatesConfig(repo);

      await expect(useCase.execute(validPatch({ [field]: '1000000' }))).rejects.toBeInstanceOf(
        ExternalBulkValidationError,
      );
      // la fila sigue en defaults: el rechazo no escribió nada
      expect((await repo.get()).utilityRate).toBe('0.0120');
    },
  );

  it('"999999999999.9999" (el monstruo que hacía overflow de safe-integer) ⇒ 400 tipado, jamás un 500', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    await expect(useCase.execute(validPatch({ marketingRate: '999999999999.9999' }))).rejects.toBeInstanceOf(
      ExternalBulkValidationError,
    );
  });

  it('"999999.9999" (el MÁXIMO exacto de DECIMAL(10,4)) SÍ se acepta — el borde no se cierra de más', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    const result = await useCase.execute(validPatch({ marketingRate: '999999.9999' }));

    expect(result.marketingRate).toBe('999999.9999');
  });

  it('el error trae un mensaje que nombra el tope (mostrable por el FE)', async () => {
    const repo = new InMemoryMessagingRatesConfigRepository({ now: () => NOW });
    const useCase = new SetMessagingRatesConfig(repo);

    await expect(useCase.execute(validPatch({ providerFee: '1000000.0000' }))).rejects.toThrow(/999999\.9999/);
  });
});
