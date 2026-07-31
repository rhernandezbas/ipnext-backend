import { z } from 'zod';
import { TicketComment, TicketCommentAuthorKind } from '@domain/entities/ticketComment';

/**
 * portal-ticket-messaging (v2.B) — DTO de un mensaje visible por el portal.
 * `authorKind` SÍ viaja (el cliente necesita saber "esto lo escribí yo" vs "esto
 * lo escribió soporte" para renderizar el chat) — `authorId`/`visibility` NO: el
 * primero es un id interno (PortalAccount/RbacUser) sin valor para el cliente, el
 * segundo es SIEMPRE 'public' en este DTO por construcción (viene de
 * `listPublicByTicket`), exponerlo sería ruido.
 */
export interface PortalTicketMessageAttachmentDto {
  id: string;
  kind: 'image' | 'audio' | 'video';
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Ruta del BE que sirve el binario (auth + pertenencia validadas por request — nunca una URL pública ni eterna). */
  url: string;
}

export interface PortalTicketMessageDto {
  id: string;
  authorKind: TicketCommentAuthorKind;
  body: string;
  createdAt: string;
  attachments: PortalTicketMessageAttachmentDto[];
}

/**
 * Mapea un `TicketComment` (YA filtrado a `visibility=public` por el repo) a su
 * DTO de portal. Solo incluye adjuntos de la mensajería NUEVA (`storageKey` no
 * nulo) — el sistema viejo de notas internas (`url` data-URI) nunca puede llegar
 * acá de todos modos porque siempre es `visibility=internal`, pero el filtro
 * queda explícito por si algún día conviven.
 */
export function toPortalTicketMessageDto(comment: TicketComment, attachmentUrlPrefix: string): PortalTicketMessageDto {
  return {
    id: comment.id,
    authorKind: comment.authorKind,
    body: comment.body,
    createdAt: comment.createdAt,
    attachments: comment.attachments
      .filter((a) => a.storageKey != null && a.kind != null)
      .map((a) => ({
        id: a.id,
        kind: a.kind as 'image' | 'audio' | 'video',
        filename: a.filename,
        mimeType: a.mimeType ?? null,
        sizeBytes: a.sizeBytes ?? null,
        url: `${attachmentUrlPrefix}/${a.id}/file`,
      })),
  };
}

/**
 * portal-ticket-messaging (v2.B) — body del `POST /api/portal/tickets/:number/
 * messages`. `.strict()` A PROPÓSITO: la visibilidad de este endpoint es SIEMPRE
 * `public` + `authorKind=client` — la determina la RUTA, no el payload. Si el
 * cliente del API manda `visibility` (o cualquier campo desconocido) en el body,
 * `.strict()` lo rechaza con 400 ruidoso en vez de ignorarlo en silencio — un
 * campo que no existe en el schema no puede cambiar el resultado por definición.
 *
 * Solo valida FORMA acá (tipo string + sin campos extra). El contenido —vacío
 * sin adjuntos, o excede el largo máximo— se valida en el USE CASE
 * (`SendPortalTicketMessage`), mismo criterio que `CreatePortalTicket`
 * (PORTAL_TICKET_SUBJECT_MAX_LEN/DESCRIPTION_MAX_LEN viven ahí, no en zod): una
 * sola fuente de verdad para las reglas de negocio, la ruta solo filtra forma.
 *
 * El largo máximo vive en `MAX_MESSAGE_BODY_LEN` (ticketMessageAttachments.ts) —
 * una sola constante para los dos lados (cliente/staff), no duplicada acá.
 */
export const SendPortalTicketMessageSchema = z
  .object({
    body: z.string().default(''),
  })
  .strict();

/** Tipo del BODY parseado por zod (solo texto) — distinto de `SendPortalTicketMessageInput`
 * (use case), que además incluye los `files` ya extraídos por multer. */
export type SendPortalTicketMessageBody = z.infer<typeof SendPortalTicketMessageSchema>;
