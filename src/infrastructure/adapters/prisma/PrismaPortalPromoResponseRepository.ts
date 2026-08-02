import { prisma } from '../../database/prisma';
import type { PortalPromoResponse, PortalPromoResponseKind } from '@domain/entities/portalPromo';
import type {
  PortalPromoResponseRepository,
  CreatePortalPromoResponseData,
} from '@domain/ports/PortalPromoResponseRepository';

interface PortalPromoResponseRow {
  id: string;
  promoId: string;
  clientId: string;
  kind: string;
  ticketId: string | null;
  createdAt: Date;
}

function toEntity(row: PortalPromoResponseRow): PortalPromoResponse {
  return {
    id: row.id,
    promoId: row.promoId,
    clientId: row.clientId,
    kind: row.kind as PortalPromoResponseKind,
    ticketId: row.ticketId,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaPortalPromoResponseRepository implements PortalPromoResponseRepository {
  async findByPromoAndClient(promoId: string, clientId: string): Promise<PortalPromoResponse | null> {
    const row = await prisma.portalPromoResponse.findUnique({
      where: { promoId_clientId: { promoId, clientId } },
    });
    return row ? toEntity(row) : null;
  }

  /**
   * Atrapa P2002 sobre el `@@unique([promoId, clientId])` — dos requests
   * concurrentes del mismo cliente sobre la misma promo: el perdedor re-lee
   * la fila del ganador en vez de propagar el error (contrato del port).
   */
  async create(data: CreatePortalPromoResponseData): Promise<PortalPromoResponse> {
    try {
      const row = await prisma.portalPromoResponse.create({
        data: {
          promoId: data.promoId,
          clientId: data.clientId,
          kind: data.kind,
          ticketId: data.ticketId ?? null,
        },
      });
      return toEntity(row);
    } catch (err) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        const existing = await this.findByPromoAndClient(data.promoId, data.clientId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async listRespondedPromoIds(clientId: string): Promise<string[]> {
    const rows = await prisma.portalPromoResponse.findMany({
      where: { clientId },
      select: { promoId: true },
    });
    return rows.map((r) => r.promoId);
  }
}
