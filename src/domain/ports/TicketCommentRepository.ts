import { TicketComment, TicketCommentAttachment } from '../entities/ticketComment';

/** Resultado de resolver un adjunto por id — trae el contexto mínimo para autorizar
 * el acceso (pertenencia + visibilidad) SIN tener que resolver el TicketComment entero. */
export interface TicketCommentAttachmentWithContext extends TicketCommentAttachment {
  ticketId: string;
  visibility: TicketComment['visibility'];
}

export interface TicketCommentRepository {
  /** TODOS los comentarios (cualquier visibilidad) — uso admin/staff exclusivamente. */
  listByTicket(ticketId: string): Promise<TicketComment[]>;
  /**
   * portal-ticket-messaging (v2.B) — INVARIANTE CENTRAL: solo `visibility = 'public'`.
   * El filtro vive en la QUERY de cada adapter (WHERE), no acá ni en un mapper — este
   * método es el ÚNICO camino por el que el portal puede leer comentarios; ningún
   * caso de uso del portal debe llamar a `listByTicket` en su lugar.
   */
  listPublicByTicket(ticketId: string): Promise<TicketComment[]>;
  create(comment: TicketComment): Promise<TicketComment>;
  /**
   * No leídos por lado (spec "No leídos por lado"). `side='client'` cuenta los
   * públicos escritos por staff después de `since`; `side='staff'` cuenta TODO lo
   * escrito por el cliente después de `since` (el staff ve todo, no solo lo público).
   * `since=null` ⇒ "nunca leyó" ⇒ cuenta desde el origen del hilo.
   */
  countUnread(ticketId: string, side: 'client' | 'staff', since: Date | null): Promise<number>;
  /** Resuelve un adjunto por id con el contexto necesario para autorizar el acceso. Null si no existe. */
  findAttachmentById(attachmentId: string): Promise<TicketCommentAttachmentWithContext | null>;
}
