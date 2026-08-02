import type { CampaignSegmentSource, CampaignSegmentFilter } from '@domain/ports/CustomerRepository';
import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { AudiencePreviewDto } from '@application/dto/promos.dto';

/**
 * PreviewPromoAudience — admin, `POST /api/promos/audience-preview`.
 *
 * `segmentCount` sale de `listSegmentRecipients` — el MISMO motor que resuelve
 * campañas de mensajería (`buildSegmentWhere`), y por construcción el MISMO
 * universo que `clientMatchesSegment` reconoce cliente a cliente (ver
 * `SegmentMembershipChecker`) — así el operador ve un número que es fiel a lo
 * que el cliente realmente va a ver en `GET /promos`.
 *
 * `withAppCount` — de esos, cuántos tienen `PortalAccount`. Es el ÚNICO
 * número honesto de "a quién le llega DE VERDAD" (hoy, con el rollout acotado
 * del portal, puede dar 1 y es correcto que lo diga).
 */
export class PreviewPromoAudience {
  constructor(
    private readonly segmentSource: Pick<CampaignSegmentSource, 'listSegmentRecipients'>,
    private readonly portalAccounts: Pick<PortalAccountRepository, 'countByClientIds'>,
  ) {}

  async execute(segment: CampaignSegmentFilter): Promise<AudiencePreviewDto> {
    const candidates = await this.segmentSource.listSegmentRecipients(segment);
    const segmentCount = candidates.length;
    const withAppCount = await this.portalAccounts.countByClientIds(candidates.map((c) => c.clientId));
    return { segmentCount, withAppCount };
  }
}
