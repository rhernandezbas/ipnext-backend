import { TicketCommentRepository, TicketCommentAttachmentWithContext } from '@domain/ports/TicketCommentRepository';
import { TicketComment } from '@domain/entities/ticketComment';

export class InMemoryTicketCommentRepository implements TicketCommentRepository {
  private readonly store: TicketComment[] = [];

  async listByTicket(ticketId: string): Promise<TicketComment[]> {
    return this.store
      .filter((c) => c.ticketId === ticketId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /**
   * portal-ticket-messaging (v2.B) — INVARIANTE CENTRAL: el filtro `visibility ===
   * 'public'` vive ACÁ, en la query del repo — no en un mapper aguas abajo. Si
   * alguien invierte esta condición (`!== 'public'`), un test que ejercite ESTE
   * adapter con un fixture mixto (público + interno) debe fallar en rojo — ver
   * `ListPortalTicketMessages.test.ts` "revert-probe".
   *
   * CORRECCIÓN (fix wave F1): esa garantía es SOLO sobre este in-memory. En prod
   * corre `PrismaTicketCommentRepository.listPublicByTicket`, un gemelo
   * INDEPENDIENTE — invertir SU condición no toca este archivo, y hasta esta fix
   * wave no había ningún test sobre el adapter Prisma (`rg -l
   * PrismaTicketCommentRepository src/__tests__` daba vacío: un revisor borró el
   * filtro del WHERE real y las 5 suites de mensajería quedaron 35/35 verde). Ver
   * `PrismaTicketCommentRepository.where.test.ts` para el revert-probe que SÍ
   * cubre el código que corre en prod.
   */
  async listPublicByTicket(ticketId: string): Promise<TicketComment[]> {
    return this.store
      .filter((c) => c.ticketId === ticketId && c.visibility === 'public')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async create(comment: TicketComment): Promise<TicketComment> {
    this.store.push(comment);
    return comment;
  }

  async countUnread(ticketId: string, side: 'client' | 'staff', since: Date | null): Promise<number> {
    const sinceIso = since ? since.toISOString() : null;
    return this.store.filter((c) => {
      if (c.ticketId !== ticketId) return false;
      if (sinceIso !== null && c.createdAt <= sinceIso) return false;
      if (side === 'client') {
        // El cliente solo puede tener no-leídos de mensajes PÚBLICOS escritos por staff.
        return c.visibility === 'public' && c.authorKind === 'staff';
      }
      // El staff ve todo lo que el cliente escribió (siempre público, por definición
      // de su ruta) — no hay adjunto "interno" del lado cliente que filtrar.
      return c.authorKind === 'client';
    }).length;
  }

  async findAttachmentById(attachmentId: string): Promise<TicketCommentAttachmentWithContext | null> {
    for (const comment of this.store) {
      const attachment = comment.attachments.find((a) => a.id === attachmentId);
      if (attachment) {
        return { ...attachment, ticketId: comment.ticketId, visibility: comment.visibility };
      }
    }
    return null;
  }
}
