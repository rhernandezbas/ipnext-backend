import { randomUUID } from 'crypto';
import type { StoreOrder } from '@domain/entities/storeProduct';
import type { StoreOrderRepository, CreateStoreOrderData } from '@domain/ports/StoreOrderRepository';

export class InMemoryStoreOrderRepository implements StoreOrderRepository {
  private readonly store: StoreOrder[] = [];

  async create(data: CreateStoreOrderData): Promise<StoreOrder> {
    const order: StoreOrder = {
      id: randomUUID(),
      productId: data.productId,
      clientId: data.clientId,
      contractId: data.contractId ?? null,
      installments: data.installments,
      priceArsAtOrder: data.priceArsAtOrder,
      ticketId: data.ticketId ?? null,
      createdAt: new Date().toISOString(),
    };
    this.store.push(order);
    return { ...order };
  }

  async list(): Promise<StoreOrder[]> {
    return [...this.store]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((o) => ({ ...o }));
  }
}
