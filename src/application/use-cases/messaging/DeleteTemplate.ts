import type { TemplateAdminPort } from '@domain/ports/TemplateMessagingPort';
import type { ActiveCampaignLookup } from '@domain/ports/CampaignRepository';
import { TemplateInUseByCampaignError } from '@domain/errors/messaging-bulk';

/**
 * Change 3 (templates CRUD) — BORRAR un template. El borrado toca Meta/WABA
 * (`deleteInWaba=true`) y es IRREVERSIBLE, así que ANTES de borrar se consulta
 * `ActiveCampaignLookup`: si hay una campaña EN VUELO (`pending`/`running`/
 * `paused`) que usa ese `contentSid` como `templateRef`, NO se borra y se lanza
 * `TemplateInUseByCampaignError` (409, con los ids de las campañas que lo
 * retienen). `paused` cuenta como en-vuelo (es reanudable — mismo criterio que
 * `deriveLiveCounters`/`ListCampaigns`); solo las TERMINADAS (`done`/`failed`) no
 * bloquean.
 *
 * Depende de dos ports segregados (ISP): `TemplateAdminPort` (el borrado real) y
 * `ActiveCampaignLookup` (el guard) — nunca de infra/Prisma/axios directo.
 */
export class DeleteTemplate {
  constructor(
    private readonly adminPort: TemplateAdminPort,
    private readonly campaignLookup: ActiveCampaignLookup,
  ) {}

  async execute(contentSid: string): Promise<void> {
    const active = await this.campaignLookup.listActiveByTemplateRef(contentSid);
    if (active.length > 0) {
      throw new TemplateInUseByCampaignError(
        contentSid,
        active.map((c) => c.id),
      );
    }
    // deleteInWaba=true — borra TAMBIÉN de Meta/WABA (decisión del usuario:
    // CRUD completo incluyendo borrar, irreversible).
    await this.adminPort.deleteTemplate(contentSid, true);
  }
}
