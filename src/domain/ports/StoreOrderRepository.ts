import type { StoreOrder } from '@domain/entities/storeProduct';

export interface CreateStoreOrderData {
  productId: string;
  clientId: string;
  contractId?: string | null;
  installments: number;
  /** Snapshot del `StoreProduct.priceArs` AL MOMENTO del pedido — ver
   * `PlaceStorePortalOrder`, nunca se recalcula contra el precio vivo. */
  priceArsAtOrder: number;
  ticketId?: string | null;
}

export interface StoreOrderRepository {
  create(data: CreateStoreOrderData): Promise<StoreOrder>;
  /** Admin — TODOS los pedidos, createdAt desc. El join con producto/cliente/
   * ticket lo arma el use case (`ListStoreOrdersAdmin`, N+1 acotado — mismo
   * criterio "pocas decenas" que `ListPortalBenefits`), no este port. */
  list(): Promise<StoreOrder[]>;
}
