/**
 * external-bulk-messaging (task 4.1, CONFIG-1) — `GetExternalBulkConfig`. Delega
 * en el port; los defaults 500/2000 sin fila previa son responsabilidad del
 * repo (ya pineados en `InMemoryExternalBulkMessagingConfigRepository.test.ts`
 * / `PrismaExternalBulkMessagingConfigRepository.test.ts`, B1) — acá solo se
 * pinea que el use case NO agrega ni oculta nada del shape del repo.
 */
import { GetExternalBulkConfig } from '@application/use-cases/messaging/GetExternalBulkConfig';
import { InMemoryExternalBulkMessagingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository';

const NOW = new Date('2026-09-02T00:00:00.000Z');

describe('GetExternalBulkConfig (CONFIG-1)', () => {
  it('sin fila previa devuelve los defaults 500/2000 (delegado del repo)', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
    const useCase = new GetExternalBulkConfig(repo);

    const result = await useCase.execute();

    expect(result).toEqual({ maxPerRequest: 500, maxPerDay: 2000, updatedAt: NOW.toISOString() });
  });

  it('tras un set() previo, devuelve la config persistida (no los defaults)', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository({ now: () => NOW });
    await repo.set({ maxPerRequest: 300, maxPerDay: 1500 });
    const useCase = new GetExternalBulkConfig(repo);

    const result = await useCase.execute();

    expect(result.maxPerRequest).toBe(300);
    expect(result.maxPerDay).toBe(1500);
  });
});
