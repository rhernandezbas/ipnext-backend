/**
 * portal-ticket-messaging (v2.B) — quién escribió cada comentario y quién puede
 * verlo. Ver prisma/schema.prisma (TicketComment) para la justificación completa
 * de por qué son enums cerrados y no strings de catálogo.
 */
export type TicketCommentAuthorKind = 'client' | 'staff';
export type TicketCommentVisibility = 'public' | 'internal';

/** 'image' | 'audio' | 'video' — null en adjuntos viejos (siempre imagen, nunca etiquetada). */
export type TicketCommentAttachmentKind = 'image' | 'audio' | 'video';

export interface TicketCommentAttachment {
  id: string;
  commentId: string;
  /** Sistema VIEJO de notas internas (data-URI embebida). Null para adjuntos nuevos (storageKey). */
  url: string | null;
  /** v2.B — key de MinIO (patrón BE-proxy). Null para adjuntos viejos (url). Nunca ambos. */
  storageKey: string | null;
  kind: TicketCommentAttachmentKind | null;
  filename: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  /** Polimórfico: PortalAccount.id si authorKind=client, RbacUser.id si authorKind=staff. */
  authorId: string | null;
  authorKind: TicketCommentAuthorKind;
  visibility: TicketCommentVisibility;
  authorName: string;
  body: string;
  createdAt: string;
  attachments: TicketCommentAttachment[];
}
