/**
 * external-bulk-messaging (1.5) — InMemoryExternalBulkPreviewRepository. Molde
 * InMemoryCampaignRepository (Map-backed). Cubre round-trip create/findById,
 * la carrera de `markConsumed` (D3.b/D8 — ganador único) y `deleteExpiredBefore`.
 */
import { InMemoryExternalBulkPreviewRepository } from '@infrastructure/adapters/in-memory/InMemoryExternalBulkPreviewRepository';
import type { ExternalBulkPreviewCreateData } from '@domain/ports/ExternalBulkPreviewRepository';

function makeCreateData(overrides: Partial<ExternalBulkPreviewCreateData> = {}): ExternalBulkPreviewCreateData {
  return {
    payloadHash: 'hash-1',
    templateRef: 'HXabc123',
    templateName: 'recordatorio_deuda',
    variables: { '1': 'Juan' },
    chatwootLabel: null,
    recipients: [{ phoneE164: '+5493364111111', phoneNormalized: '3364111111', name: 'Juan', variables: {} }],
    invalid: [],
    validCount: 1,
    invalidCount: 0,
    expiresAt: '2026-09-02T00:15:00.000Z',
    ...overrides,
  };
}

describe('InMemoryExternalBulkPreviewRepository', () => {
  it('create persiste el preview con consumedAt/campaignId null; findById lo devuelve tal cual', async () => {
    const repo = new InMemoryExternalBulkPreviewRepository();
    const created = await repo.create(makeCreateData());

    expect(created.id).toEqual(expect.any(String));
    expect(created.payloadHash).toBe('hash-1');
    expect(created.consumedAt).toBeNull();
    expect(created.campaignId).toBeNull();
    expect(created.createdAt).toEqual(expect.any(String));

    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });

  it('findById devuelve null para un id inexistente', async () => {
    const repo = new InMemoryExternalBulkPreviewRepository();
    const found = await repo.findById('does-not-exist');
    expect(found).toBeNull();
  });

  it('dos validate idénticos generan previews independientes con id/expiresAt propios (VAL-8)', async () => {
    const repo = new InMemoryExternalBulkPreviewRepository();
    const first = await repo.create(makeCreateData());
    const second = await repo.create(makeCreateData());

    expect(first.id).not.toBe(second.id);
  });

  it('markConsumed: la PRIMERA llamada sobre un preview no-consumido gana (true), persiste consumedAt+campaignId', async () => {
    const repo = new InMemoryExternalBulkPreviewRepository();
    const created = await repo.create(makeCreateData());

    const won = await repo.markConsumed(created.id, 'campaign-1');

    expect(won).toBe(true);
    const after = await repo.findById(created.id);
    expect(after?.consumedAt).toEqual(expect.any(String));
    expect(after?.campaignId).toBe('campaign-1');
  });

  it('markConsumed: DOS llamadas concurrentes al MISMO id no-consumido — solo UNA devuelve true (D8)', async () => {
    const repo = new InMemoryExternalBulkPreviewRepository();
    const created = await repo.create(makeCreateData());

    const [r1, r2] = await Promise.all([
      repo.markConsumed(created.id, 'campaign-1'),
      repo.markConsumed(created.id, 'campaign-2'),
    ]);

    // exactamente UN ganador
    expect([r1, r2].filter(Boolean)).toHaveLength(1);
  });

  it('markConsumed sobre un preview YA consumido devuelve false (no pisa el campaignId original)', async () => {
    const repo = new InMemoryExternalBulkPreviewRepository();
    const created = await repo.create(makeCreateData());
    await repo.markConsumed(created.id, 'campaign-1');

    const second = await repo.markConsumed(created.id, 'campaign-2');

    expect(second).toBe(false);
    const after = await repo.findById(created.id);
    expect(after?.campaignId).toBe('campaign-1'); // NO pisado por el segundo intento
  });

  it('deleteExpiredBefore borra SOLO los previews con expiresAt < before, acotado por limit', async () => {
    const repo = new InMemoryExternalBulkPreviewRepository();
    const expired = await repo.create(makeCreateData({ expiresAt: '2026-01-01T00:00:00.000Z' }));
    const alive = await repo.create(makeCreateData({ expiresAt: '2099-01-01T00:00:00.000Z' }));

    const deletedCount = await repo.deleteExpiredBefore(new Date('2026-06-01T00:00:00.000Z'), 500);

    expect(deletedCount).toBe(1);
    expect(await repo.findById(expired.id)).toBeNull();
    expect(await repo.findById(alive.id)).not.toBeNull();
  });

  it('deleteExpiredBefore respeta el limit (no borra más de lo pedido)', async () => {
    const repo = new InMemoryExternalBulkPreviewRepository();
    await repo.create(makeCreateData({ expiresAt: '2026-01-01T00:00:00.000Z' }));
    await repo.create(makeCreateData({ expiresAt: '2026-01-02T00:00:00.000Z' }));
    await repo.create(makeCreateData({ expiresAt: '2026-01-03T00:00:00.000Z' }));

    const deletedCount = await repo.deleteExpiredBefore(new Date('2026-06-01T00:00:00.000Z'), 2);

    expect(deletedCount).toBe(2);
  });
});
