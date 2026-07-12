import { WebhookDeliveryRepository } from '@domain/ports/WebhookDeliveryRepository';
import { prisma } from '../../database/prisma';

/**
 * messaging-inbox (F1) — Prisma adapter for `WebhookDeliveryRepository`.
 * `create()` + catch P2002 (unique `[source, deliveryId]` violation) → `false`,
 * same "unique + catch carrera" pattern as `sourceContractId` in
 * `PrismaOwnershipCaseRepository`. Not unit-tested (design/tasks §B2).
 */
export class PrismaWebhookDeliveryRepository implements WebhookDeliveryRepository {
  async hasSeen(source: string, deliveryId: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).webhookDelivery.findUnique({
      where: { source_deliveryId: { source, deliveryId } },
    });
    return row !== null;
  }

  async recordIfNew(source: string, deliveryId: string): Promise<boolean> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).webhookDelivery.create({ data: { source, deliveryId } });
      return true;
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') return false;
      throw err;
    }
  }
}
