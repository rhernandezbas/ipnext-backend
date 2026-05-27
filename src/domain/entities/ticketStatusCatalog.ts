/** Editable catalog entry for a ticket status. */
export interface TicketStatusCatalog {
  id: string;
  name: string;
  /** Hex color used for the status pill/badge in the UI. */
  color: string;
  /** Sort weight — lower means it appears first in lists. */
  weight: number;
}
