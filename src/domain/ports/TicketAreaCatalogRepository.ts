import { TicketAreaCatalog } from '../entities/ticket-area-catalog';

/** Fields an admin can set when creating/editing an area (all portal-* fields optional). */
export interface TicketAreaCatalogWriteData {
  name: string;
  color: string;
  portalVisible?: boolean;
  portalLabel?: string | null;
  portalDescription?: string | null;
  portalOrder?: number;
}

export interface TicketAreaCatalogRepository {
  list(): Promise<TicketAreaCatalog[]>;
  getById(id: string): Promise<TicketAreaCatalog | null>;
  getByName(name: string): Promise<TicketAreaCatalog | null>;
  create(data: TicketAreaCatalogWriteData): Promise<TicketAreaCatalog>;
  update(id: string, data: Partial<TicketAreaCatalogWriteData>): Promise<TicketAreaCatalog | null>;
  delete(id: string): Promise<boolean>;
  /** How many Ticket rows reference this area id (delete guard). */
  countInUse(areaId: string): Promise<number>;
  /**
   * portal-ticket-topic — SOLO áreas con `portalVisible = true`, ordenadas
   * `portalOrder ASC, name ASC`. El filtro va DENTRO del WHERE del adapter —
   * NUNCA se resuelve filtrando `list()` desde una capa de arriba (ver
   * ListPortalTicketTopics).
   */
  listPortalVisible(): Promise<TicketAreaCatalog[]>;
  /**
   * portal-ticket-topic — devuelve el área SOLO si existe Y `portalVisible =
   * true`. Es la AUTORIDAD de seguridad: un `id` de un área interna (NOC/
   * GigaRed) o inexistente devuelve `null` en los dos casos por igual — el
   * caller (`CreatePortalTicket`) no puede distinguir cuál pasó (anti-
   * enumeración, mismo criterio que `PortalContractNotFoundError`).
   */
  getPortalVisibleById(id: string): Promise<TicketAreaCatalog | null>;
}
