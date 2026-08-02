/**
 * store-backend — tienda del ISP. El STAFF carga productos en Prominense; el
 * cliente los ve en la app y pide con "Lo quiero" eligiendo forma de pago (1
 * pago o cuotas EN LA FACTURA — sin pasarela en v1). El pedido abre una
 * conversación (Ticket) donde el equipo coordina.
 *
 * Legal AR (maqueta aprobada): precio final, cuotas claras, garantía y
 * arrepentimiento de 10 días viven como TEXTO del producto (`warrantyText`),
 * nunca como lógica de negocio separada — el operador es responsable de
 * cargar el texto legal correcto.
 */
export interface StoreProduct {
  id: string;
  title: string;
  /** Línea corta de la card del catálogo. */
  summary: string;
  /** Texto largo del detalle. */
  description: string;
  priceArs: number;
  /** 1 = solo un pago; N = hasta N cuotas SIN interés (priceArs/N). */
  maxInstallments: number;
  warrantyText: string;
  /** ej. "Recomendado". Opcional. */
  badge: string | null;
  /** MinIO — mismo patrón que los adjuntos de mensajería (storageKey, no URL pública). */
  imageStorageKey: string | null;
  /** Área del ticket del pedido. null = área default del portal. */
  ticketAreaId: string | null;
  /** false = borrador: el cliente NO lo ve (lado seguro, default). */
  active: boolean;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Un pedido — snapshot INMUTABLE del precio y las cuotas elegidas en el
 * momento de la compra (`priceArsAtOrder`): el catálogo puede cambiar de
 * precio después sin alterar pedidos ya hechos (ver `PlaceStorePortalOrder`).
 */
export interface StoreOrder {
  id: string;
  productId: string;
  clientId: string;
  contractId: string | null;
  installments: number;
  priceArsAtOrder: number;
  ticketId: string | null;
  createdAt: string;
}
