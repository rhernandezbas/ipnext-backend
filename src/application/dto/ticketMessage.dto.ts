import { z } from 'zod';
import { TicketComment } from '@domain/entities/ticketComment';

/**
 * portal-ticket-messaging (v2.B) — body de `POST /api/tickets/:ticketId/messages`
 * (respuesta PÚBLICA del staff). `.strict()` A PROPÓSITO — mismo criterio que
 * `SendPortalTicketMessageSchema`: la visibilidad de ESTA ruta es SIEMPRE
 * `public`, la determina la ruta (`SendStaffTicketReply`, visibility fijo),
 * nunca el body. Si alguien manda `visibility` acá, 400 ruidoso — no se
 * ignora en silencio, no cambia nada aunque se mande.
 */
export const SendStaffTicketReplySchema = z
  .object({
    body: z.string().default(''),
    authorName: z.string().min(1).optional(),
  })
  .strict();

export type SendStaffTicketReplyBody = z.infer<typeof SendStaffTicketReplySchema>;

/** DTO de salida — el staff ve TODO el comentario (autoría/visibilidad incluidas, a diferencia del portal). */
export interface TicketMessageDto {
  id: string;
  ticketId: string;
  authorId: string | null;
  authorKind: TicketComment['authorKind'];
  visibility: TicketComment['visibility'];
  authorName: string;
  body: string;
  createdAt: string;
  attachments: Array<{
    id: string;
    kind: 'image' | 'audio' | 'video' | null;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
    url: string;
  }>;
}

export function toTicketMessageDto(comment: TicketComment): TicketMessageDto {
  return {
    id: comment.id,
    ticketId: comment.ticketId,
    authorId: comment.authorId,
    authorKind: comment.authorKind,
    visibility: comment.visibility,
    authorName: comment.authorName,
    body: comment.body,
    createdAt: comment.createdAt,
    attachments: comment.attachments
      .filter((a) => a.storageKey != null)
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        filename: a.filename,
        mimeType: a.mimeType ?? null,
        sizeBytes: a.sizeBytes ?? null,
        url: `/api/tickets/messages/attachments/${a.id}/file`,
      })),
  };
}
