import type { PortalPromoResponse, PortalPromoResponseKind } from '@domain/entities/portalPromo';

export interface CreatePortalPromoResponseData {
  promoId: string;
  clientId: string;
  kind: PortalPromoResponseKind;
  /** Solo para kind='interested'. */
  ticketId?: string | null;
}

export interface PortalPromoResponseRepository {
  findByPromoAndClient(promoId: string, clientId: string): Promise<PortalPromoResponse | null>;
  /**
   * Crea la respuesta. El `@@unique([promoId, clientId])` de la tabla es la
   * red REAL de idempotencia (dos requests concurrentes del mismo cliente NO
   * pueden crear dos filas) — la implementación DEBE atrapar la violación de
   * esa constraint (Prisma P2002) y devolver la fila YA existente en vez de
   * dejar escapar el error crudo. El caller (`InterestInPortalPromo`/
   * `DismissPortalPromo`) hace un chequeo previo por UX/costo, nunca confía
   * en él como única defensa.
   */
  create(data: CreatePortalPromoResponseData): Promise<PortalPromoResponse>;
  /**
   * Set de promoIds a los que este cliente YA respondió (interested o
   * dismissed) — UNA query, usada para excluir de `PortalPromoRepository
   * .listActive` en memoria (nunca N+1: no se llama `findByPromoAndClient`
   * por cada promo del listado).
   */
  listRespondedPromoIds(clientId: string): Promise<string[]>;
}
