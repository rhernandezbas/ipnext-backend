/**
 * external-bulk-messaging (task 4.1, CONFIG-3) — `SetExternalBulkConfig`.
 * Rechaza valores no-entero-positivos y `maxPerRequest > maxPerDay` SIN tocar
 * el repo (config no se persiste); un update válido persiste y `get()`
 * posterior lo refleja. Inputs tipados `unknown` a propósito — el use case es
 * la ÚLTIMA barrera de tipo antes de tocar el repo (la ruta HTTP, task 4.4, no
 * duplica este chequeo con zod).
 */
import { SetExternalBulkConfig } from '@application/use-cases/messaging/SetExternalBulkConfig';
import { InMemoryExternalBulkMessagingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository';
import { ExternalBulkValidationError } from '@domain/errors/external-bulk-messaging';
import { MAX_MANUAL_CONTACTS } from '@application/use-cases/messaging/resolveCombinedRecipients';

const NOW = new Date('2026-09-02T00:00:00.000Z');

describe('SetExternalBulkConfig (CONFIG-3)', () => {
  it('rechaza maxPerRequest > maxPerDay sin persistir', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
    const useCase = new SetExternalBulkConfig(repo);

    await expect(useCase.execute({ maxPerRequest: 3000, maxPerDay: 2000 })).rejects.toThrow(
      ExternalBulkValidationError,
    );
    const after = await repo.get();
    expect(after.maxPerRequest).toBe(500); // default intacto — no se persistió
    expect(after.maxPerDay).toBe(2000);
  });

  it('rechaza un valor no-positivo (0)', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
    const useCase = new SetExternalBulkConfig(repo);

    await expect(useCase.execute({ maxPerRequest: 0, maxPerDay: 2000 })).rejects.toThrow(
      ExternalBulkValidationError,
    );
  });

  it('rechaza un valor negativo', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
    const useCase = new SetExternalBulkConfig(repo);

    await expect(useCase.execute({ maxPerRequest: -5, maxPerDay: 2000 })).rejects.toThrow(
      ExternalBulkValidationError,
    );
  });

  it('rechaza un valor decimal (no entero)', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
    const useCase = new SetExternalBulkConfig(repo);

    await expect(useCase.execute({ maxPerRequest: 10.5, maxPerDay: 2000 })).rejects.toThrow(
      ExternalBulkValidationError,
    );
  });

  it('rechaza un valor no-numérico (string), sin reventar con un TypeError crudo', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
    const useCase = new SetExternalBulkConfig(repo);

    await expect(
      useCase.execute({ maxPerRequest: 'abc' as unknown as number, maxPerDay: 2000 }),
    ).rejects.toThrow(ExternalBulkValidationError);
  });

  it('persiste un update válido y get() posterior lo refleja', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
    const useCase = new SetExternalBulkConfig(repo);

    const result = await useCase.execute({ maxPerRequest: 300, maxPerDay: 1500 });

    expect(result).toEqual({ maxPerRequest: 300, maxPerDay: 1500, updatedAt: NOW.toISOString() });
    const after = await repo.get();
    expect(after.maxPerRequest).toBe(300);
    expect(after.maxPerDay).toBe(1500);
  });

  /**
   * fix wave F1 (finding F4) — `maxPerRequest` no tenia techo contra
   * `MAX_MANUAL_CONTACTS` (5000), la cota DURA de `resolveCombinedRecipients`.
   * Con `maxPerRequest: 6000` el sistema quedaba en un estado imposible:
   * `validate` aceptaba 5500 destinatarios (200 + preview persistido) y el
   * `send` de ESE preview reventaba con 422 TOO_MANY_MANUAL_CONTACTS para
   * siempre. La config no puede prometer mas de lo que el motor puede enviar.
   */
  describe('fix wave F1 (F4) — techo de maxPerRequest contra MAX_MANUAL_CONTACTS', () => {
    it('rechaza maxPerRequest > MAX_MANUAL_CONTACTS sin persistir, nombrando el techo en el mensaje', async () => {
      const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
      const useCase = new SetExternalBulkConfig(repo);

      await expect(
        useCase.execute({ maxPerRequest: MAX_MANUAL_CONTACTS + 1, maxPerDay: 100000 }),
      ).rejects.toThrow(new RegExp(String(MAX_MANUAL_CONTACTS)));

      const after = await repo.get();
      expect(after.maxPerRequest).toBe(500); // default intacto
    });

    it('acepta exactamente MAX_MANUAL_CONTACTS (el techo es inclusivo)', async () => {
      const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
      const useCase = new SetExternalBulkConfig(repo);

      const result = await useCase.execute({ maxPerRequest: MAX_MANUAL_CONTACTS, maxPerDay: MAX_MANUAL_CONTACTS });

      expect(result.maxPerRequest).toBe(MAX_MANUAL_CONTACTS);
    });
  });

  it('acepta maxPerRequest === maxPerDay (igualdad permitida, no es "exceder")', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
    const useCase = new SetExternalBulkConfig(repo);

    const result = await useCase.execute({ maxPerRequest: 500, maxPerDay: 500 });

    expect(result.maxPerRequest).toBe(500);
    expect(result.maxPerDay).toBe(500);
  });
});
