import type { ConversationEventRepository } from '@domain/ports/ConversationEventRepository';
import { MESSAGING_REPORTS_TIMEZONE, type ResolutionsReportDto } from '@application/dto/messagingReports';

/**
 * GetResolutionsReport (conversation-events Ola 2, reports/resolutions) — eventos 'resolved'
 * en `[from,to)` agrupados por día calendario (zona AR). El agrupado (anti-N+1) vive en el
 * adapter; este use case sólo etiqueta la zona en el DTO. Días sin resoluciones se OMITEN
 * (el FE rellena con 0).
 */
export class GetResolutionsReport {
  constructor(private readonly eventRepo: ConversationEventRepository) {}

  async execute(fromIso: string, toIso: string): Promise<ResolutionsReportDto> {
    const days = await this.eventRepo.resolvedCountByDay(fromIso, toIso);
    return { timezone: MESSAGING_REPORTS_TIMEZONE, days };
  }
}
