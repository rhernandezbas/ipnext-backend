import { InMemoryWebhookDeliveryRepository } from '@infrastructure/adapters/in-memory/InMemoryWebhookDeliveryRepository';

describe('InMemoryWebhookDeliveryRepository', () => {
  let repo: InMemoryWebhookDeliveryRepository;

  beforeEach(() => {
    repo = new InMemoryWebhookDeliveryRepository();
  });

  it('records a never-seen delivery id and returns true (HOOK-3 first delivery)', async () => {
    const result = await repo.recordIfNew('chatwoot', 'delivery-1');
    expect(result).toBe(true);
  });

  it('returns false for a delivery id already recorded (HOOK-3 duplicate)', async () => {
    await repo.recordIfNew('chatwoot', 'delivery-1');

    const result = await repo.recordIfNew('chatwoot', 'delivery-1');

    expect(result).toBe(false);
  });

  it('dedups by the (source, deliveryId) PAIR — same deliveryId under a different source is NOT a duplicate', async () => {
    await repo.recordIfNew('chatwoot', 'delivery-1');

    const result = await repo.recordIfNew('other-source', 'delivery-1');

    expect(result).toBe(true);
  });
});
