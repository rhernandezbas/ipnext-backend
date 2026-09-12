import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataMessageRepository } from '@domain/ports/SuricataMessageRepository';
import type { SuricataAttachmentRepository } from '@domain/ports/SuricataAttachmentRepository';
import type { SuricataVerdictRepository } from '@domain/ports/SuricataVerdictRepository';
import type { SuricataAreaRepository } from '@domain/ports/SuricataAreaRepository';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { SuricataTicketNotFoundError } from '@domain/errors/suricata';
import { deriveSuricataBotState } from '@domain/entities/suricataBotState';
import { isSuricataVerdictStale } from '@domain/entities/suricataVerdictStale';
import type { SuricataTicketDetailDto } from '@application/dto/suricata.dto';

/**
 * suricata-tickets-mirror (Phase F, task F.1, spec UI-2..UI-5, design D13) —
 * assembles the full ticket detail exclusively from the mirror: messages,
 * attachments, and the FULL verdict history (newest first) — zero live
 * Suricata calls (UI-2's explicit requirement). `ticketId` is the LOCAL id
 * (same convention as `ReplyToSuricataTicket`, Phase E).
 */
export class GetSuricataTicketDetail {
  constructor(
    private readonly tickets: SuricataTicketRepository,
    private readonly messages: SuricataMessageRepository,
    private readonly attachments: SuricataAttachmentRepository,
    private readonly verdicts: SuricataVerdictRepository,
    private readonly areas: SuricataAreaRepository,
    private readonly users: RbacUserRepository,
  ) {}

  async execute(ticketId: string): Promise<SuricataTicketDetailDto> {
    const ticket = await this.tickets.findById(ticketId);
    if (!ticket) throw new SuricataTicketNotFoundError(ticketId);

    const [messageRows, attachmentRows, verdictRows, areaRows, userRows] = await Promise.all([
      this.messages.listByTicketId(ticket.id),
      this.attachments.listByTicketId(ticket.id),
      this.verdicts.listByTicket(ticket.id),
      this.areas.list(),
      this.users.list(),
    ]);

    const areaName = ticket.areaId
      ? areaRows.find((a) => a.id === ticket.areaId)?.name ?? null
      : null;
    const assigneeName = ticket.assigneeId
      ? userRows.find((u) => u.id === ticket.assigneeId)?.name ?? null
      : null;

    const sortedVerdicts = [...verdictRows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latestVerdict = sortedVerdicts[0] ?? null;
    const botState = deriveSuricataBotState(ticket, latestVerdict);

    return {
      id: ticket.id,
      externalId: ticket.externalId,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      areaId: ticket.areaId,
      areaName,
      customerName: ticket.customerName,
      customerEmail: ticket.customerEmail,
      customerPhone: ticket.customerPhone,
      externalClientRef: ticket.externalClientRef,
      clientId: ticket.clientId,
      botState,
      assigneeId: ticket.assigneeId,
      assigneeName,
      openedAt: ticket.openedAt,
      lastMessageAt: ticket.lastMessageAt,
      syncedAt: ticket.syncedAt,
      messages: [...messageRows]
        .sort((a, b) => a.sentAt.localeCompare(b.sentAt))
        .map((m) => ({ id: m.id, author: m.author, authorKind: m.authorKind, body: m.body, sentAt: m.sentAt })),
      attachments: attachmentRows.map((a) => ({
        id: a.id,
        messageId: a.messageId,
        fileName: a.fileName,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        status: a.status,
      })),
      verdicts: sortedVerdicts.map((v) => ({
        id: v.id,
        resuelto: v.resuelto,
        analisis: v.analisis,
        motivo: v.motivo,
        respuestaSugerida: v.respuestaSugerida,
        createdAt: v.createdAt,
        stale: isSuricataVerdictStale(v, ticket.contentHash),
      })),
    };
  }
}
