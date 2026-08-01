/** Editable catalog entry for a ticket area. */
export interface TicketAreaCatalog {
  id: string;
  name: string;
  /** #69 — Hex color used for the area pill in the tickets list. */
  color: string;
  /**
   * portal-ticket-topic — visible al selector de tópicos del portal de
   * clientes. Default `false` (ver el port): un área nueva, o una interna
   * como NOC/GigaRed, NO se expone hasta que alguien lo decida explícitamente.
   */
  portalVisible: boolean;
  /** Nombre que ve el CLIENTE en el selector. Null -> cae a `name` (ver ListPortalTicketTopics). */
  portalLabel: string | null;
  /** Línea de ayuda que explica cuándo elegir este tópico. */
  portalDescription: string | null;
  /** Orden de presentación en el selector del portal (ASC; empata por `name`). */
  portalOrder: number;
}
