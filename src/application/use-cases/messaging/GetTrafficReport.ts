import type { ChatMessageRepository } from '@domain/ports/ChatMessageRepository';
import { MESSAGING_REPORTS_TIMEZONE, type TrafficReportDto } from '@application/dto/messagingReports';

/**
 * GetTrafficReport (conversation-events Ola 2, reports/traffic) — heatmap de mensajes
 * INBOUND por día-de-semana × hora en zona AR (`[from,to)` sobre `chatwootCreatedAt`). El
 * agrupado (anti-N+1) vive en el adapter; este use case sólo etiqueta la zona en el DTO.
 */
export class GetTrafficReport {
  constructor(private readonly messageRepo: ChatMessageRepository) {}

  async execute(fromIso: string, toIso: string): Promise<TrafficReportDto> {
    const cells = await this.messageRepo.inboundTrafficByDowHour(fromIso, toIso);
    return { timezone: MESSAGING_REPORTS_TIMEZONE, cells };
  }
}
