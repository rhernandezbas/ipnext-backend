import { WebhookDeliveryRepository } from '@domain/ports/WebhookDeliveryRepository';

/**
 * In-memory WebhookDeliveryRepository for use-case and route tests.
 * Mirrors the Prisma adapter's `@@unique([source, deliveryId])` dedup with a
 * `Set` keyed by the composite pair.
 */
export class InMemoryWebhookDeliveryRepository implements WebhookDeliveryRepository {
  private seen = new Set<string>();

  private key(source: string, deliveryId: string): string {
    return `${source}::${deliveryId}`;
  }

  async hasSeen(source: string, deliveryId: string): Promise<boolean> {
    return this.seen.has(this.key(source, deliveryId));
  }

  async recordIfNew(source: string, deliveryId: string): Promise<boolean> {
    const key = this.key(source, deliveryId);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}
