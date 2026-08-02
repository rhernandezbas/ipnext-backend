import { randomUUID } from 'crypto';
import type { PortalPromoResponse } from '@domain/entities/portalPromo';
import type {
  PortalPromoResponseRepository,
  CreatePortalPromoResponseData,
} from '@domain/ports/PortalPromoResponseRepository';

/**
 * Test seam — emula la constraint `@@unique([promoId, clientId])` de la DB:
 * `create` sobre un par ya existente devuelve la fila YA existente en vez de
 * duplicar (mismo contrato que la implementación Prisma, que atrapa P2002).
 */
export class InMemoryPortalPromoResponseRepository implements PortalPromoResponseRepository {
  private readonly store: PortalPromoResponse[] = [];

  async findByPromoAndClient(promoId: string, clientId: string): Promise<PortalPromoResponse | null> {
    const row = this.store.find((r) => r.promoId === promoId && r.clientId === clientId);
    return row ? { ...row } : null;
  }

  async create(data: CreatePortalPromoResponseData): Promise<PortalPromoResponse> {
    const existing = this.store.find((r) => r.promoId === data.promoId && r.clientId === data.clientId);
    if (existing) return { ...existing };
    const row: PortalPromoResponse = {
      id: randomUUID(),
      promoId: data.promoId,
      clientId: data.clientId,
      kind: data.kind,
      ticketId: data.ticketId ?? null,
      createdAt: new Date().toISOString(),
    };
    this.store.push(row);
    return { ...row };
  }

  async listRespondedPromoIds(clientId: string): Promise<string[]> {
    return this.store.filter((r) => r.clientId === clientId).map((r) => r.promoId);
  }

  async listByClient(clientId: string): Promise<PortalPromoResponse[]> {
    return this.store.filter((r) => r.clientId === clientId).map((r) => ({ ...r }));
  }
}
