/**
 * conversation-labels (Ola 5) — catalog entry for a conversation label (etiqueta
 * de color del inbox). Calco de `TicketAreaCatalog`: id + display `name` + hex
 * `color`. `createdAt`/`updatedAt` viven en la fila Prisma pero NO en el contrato
 * de dominio (mismo criterio minimalista que `TicketAreaCatalog`).
 */
export interface ConversationLabel {
  id: string;
  name: string;
  /** Hex color (e.g. #6366f1) used for the label chip in the inbox list. */
  color: string;
}
