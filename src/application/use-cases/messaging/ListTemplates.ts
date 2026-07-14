import type { TemplateMessagingPort } from '@domain/ports/TemplateMessagingPort';
import type { TemplateSummaryDto } from '@application/dto/messaging-bulk.dto';

/**
 * messaging-bulk (F2, TPL-1/TPL-2) — lista los templates del proveedor.
 * Devuelve TODOS los templates (mixed approved/pending/rejected) mapeados a
 * DTO curado — nunca el objeto crudo de Twilio. `sendable` es `true` SOLO
 * cuando `approvalStatus === 'approved'` (TPL-2), señalizando al FE cuáles
 * son seleccionables para una campaña.
 *
 * Gate RBAC `messaging.templates` (RBAC-2) — se aplica en la ruta (Batch 7),
 * no acá.
 */
export class ListTemplates {
  constructor(private readonly templatePort: TemplateMessagingPort) {}

  async execute(): Promise<TemplateSummaryDto[]> {
    const templates = await this.templatePort.listTemplates();
    return templates.map((t) => ({
      contentSid: t.contentSid,
      friendlyName: t.friendlyName,
      language: t.language,
      variables: Object.keys(t.variables),
      approvalStatus: t.approvalStatus,
      category: t.category,
      sendable: t.approvalStatus === 'approved',
      body: t.body,
    }));
  }
}
