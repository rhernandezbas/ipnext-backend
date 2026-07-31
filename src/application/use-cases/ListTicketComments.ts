import { TicketCommentRepository } from '@domain/ports/TicketCommentRepository';
import { TicketRepository } from '@domain/ports/TicketRepository';
import { TicketComment } from '@domain/entities/ticketComment';
import { TicketNotFoundError } from '@domain/errors';

/**
 * v2.B (portal-ticket-messaging) — "abrir el hilo" del lado staff. Ver todos los
 * comentarios (público + interno, ya con autoría/visibilidad marcadas) es el
 * criterio elegido para "el operador leyó el ticket" — estampa el cursor
 * `staffMessagesReadAt` como efecto secundario best-effort (nunca bloquea ni
 * rompe la lectura si el ticket ya no existe: eso ya lo cubre el check de
 * arriba, que lanza ANTES).
 *
 * LIMITACIÓN CONOCIDA (F8, fix wave) — `staffMessagesReadAt` es UN cursor GLOBAL
 * por ticket, no por operador: si el agente A abre el ticket, el badge de
 * "no leído" desaparece para B/C/D también, aunque ellos nunca lo hayan visto.
 * Un GET también tiene el efecto secundario de ESCRIBIR (marcar leído), lo cual
 * no es un patrón REST puro. Aceptado a propósito para v2.B: modelar "leído
 * por operador" requeriría una tabla de lecturas por (ticket, usuario) — fuera
 * de alcance de esta iteración; el badge global sigue siendo mejor que ningún
 * indicador. Si esto se vuelve un problema real (equipos grandes con varios
 * operadores en el mismo ticket), la solución es esa tabla, no un parche acá.
 */
export class ListTicketComments {
  constructor(
    private readonly repo: TicketCommentRepository,
    private readonly ticketRepo: TicketRepository,
  ) {}

  async execute(ticketId: string): Promise<TicketComment[]> {
    const ticket = await this.ticketRepo.getById(ticketId);
    if (!ticket) throw new TicketNotFoundError(ticketId);
    const comments = await this.repo.listByTicket(ticketId);
    // F5 (fix wave) — mismo criterio que ListPortalTicketMessages: el cursor
    // usa el createdAt del ÚLTIMO comentario efectivamente listado, nunca
    // now() (evita perder un comentario que aterriza en la ventana entre el
    // list() y el mark). Lista vacía: se preserva now() (ver esa misma nota).
    const at = comments.length > 0
      ? new Date(comments[comments.length - 1]!.createdAt)
      : new Date();
    await this.ticketRepo.markMessagesRead(ticketId, 'staff', at);
    return comments;
  }
}
