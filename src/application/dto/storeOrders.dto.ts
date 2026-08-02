import { z } from 'zod';

/**
 * store-backend — admin, `GET /api/store/orders`. Fila enriquecida con lo que
 * el panel necesita mostrar sin un lookup aparte por el FE (producto/cliente/
 * ticket) — el join lo arma `ListStoreOrdersAdmin` (N+1 acotado, ver el
 * docblock de esa clase), no el port.
 */
export interface StoreOrderAdminDto {
  id: string;
  productId: string;
  productTitle: string;
  clientId: string;
  clientName: string | null;
  contractId: string | null;
  installments: number;
  priceArsAtOrder: number;
  ticketId: string | null;
  ticketNumber: number | null;
  createdAt: string;
}

// ─── portal — POST /api/portal/store/products/:id/order ────────────────────

export const PlaceStorePortalOrderSchema = z.object({
  contractId: z.string().trim().min(1).nullish(),
  installments: z.number().int(),
});
export type PlaceStorePortalOrderInput = z.infer<typeof PlaceStorePortalOrderSchema>;
