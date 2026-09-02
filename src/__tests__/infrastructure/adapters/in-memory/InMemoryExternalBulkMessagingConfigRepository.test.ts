/**
 * external-bulk-messaging (1.5) — InMemoryExternalBulkMessagingConfigRepository.
 * Molde InMemoryFinanceReceiptSyncConfigRepository. CONFIG-1: defaults 500/2000
 * sin fila previa; `set()` persiste y `get()` posterior refleja el patch.
 */
import { InMemoryExternalBulkMessagingConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkMessagingConfigRepository';

describe('InMemoryExternalBulkMessagingConfigRepository', () => {
  it('get() sin fila previa devuelve los defaults 500/2000 (CONFIG-1)', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository();

    const config = await repo.get();

    expect(config.maxPerRequest).toBe(500);
    expect(config.maxPerDay).toBe(2000);
    expect(config.updatedAt).toEqual(expect.any(String));
  });

  it('set() persiste el patch; get() posterior lo refleja', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository();

    const updated = await repo.set({ maxPerRequest: 300, maxPerDay: 1500 });
    const after = await repo.get();

    expect(updated.maxPerRequest).toBe(300);
    expect(updated.maxPerDay).toBe(1500);
    expect(after.maxPerRequest).toBe(300);
    expect(after.maxPerDay).toBe(1500);
  });

  it('set() sucesivos pisan el patch anterior (último gana, fila única)', async () => {
    const repo = new InMemoryExternalBulkMessagingConfigRepository();

    await repo.set({ maxPerRequest: 300, maxPerDay: 1500 });
    await repo.set({ maxPerRequest: 100, maxPerDay: 900 });
    const after = await repo.get();

    expect(after.maxPerRequest).toBe(100);
    expect(after.maxPerDay).toBe(900);
  });
});
