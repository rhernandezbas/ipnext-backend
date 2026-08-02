import { prisma } from '../../database/prisma';
import type { StoreOrder } from '@domain/entities/storeProduct';
import type { StoreOrderRepository, CreateStoreOrderData } from '@domain/ports/StoreOrderRepository';

interface StoreOrderRow {
  id: string;
  productId: string;
  clientId: string;
  contractId: string | null;
  installments: number;
  priceArsAtOrder: unknown; // Prisma.Decimal
  ticketId: string | null;
  createdAt: Date;
}

function toEntity(row: StoreOrderRow): StoreOrder {
  return {
    id: row.id,
    productId: row.productId,
    clientId: row.clientId,
    contractId: row.contractId,
    installments: row.installments,
    priceArsAtOrder: Number(row.priceArsAtOrder),
    ticketId: row.ticketId,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PrismaStoreOrderRepository implements StoreOrderRepository {
  async create(data: CreateStoreOrderData): Promise<StoreOrder> {
    const row = await prisma.storeOrder.create({
      data: {
        productId: data.productId,
        clientId: data.clientId,
        contractId: data.contractId ?? null,
        installments: data.installments,
        priceArsAtOrder: data.priceArsAtOrder,
        ticketId: data.ticketId ?? null,
      },
    });
    return toEntity(row as unknown as StoreOrderRow);
  }

  async list(): Promise<StoreOrder[]> {
    const rows = await prisma.storeOrder.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((r) => toEntity(r as unknown as StoreOrderRow));
  }
}
