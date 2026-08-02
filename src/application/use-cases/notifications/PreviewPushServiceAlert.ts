import type { CampaignSegmentSource } from '@domain/ports/CustomerRepository';
import type { PortalPushTokenRepository } from '@domain/ports/PortalPushTokenRepository';
import { resolvePushServiceAlertTargets } from './resolvePushServiceAlertTargets';

export interface PreviewPushServiceAlertInput {
  networkSiteId?: string | null;
}

export interface PreviewPushServiceAlertResult {
  recipients: number;
  devices: number;
}

/**
 * PreviewPushServiceAlert — admin, `POST /api/notifications/push-service-alert/preview`
 * (portal-push-notifications). MISMOS filtros que `SendPushServiceAlert` (vía
 * `resolvePushServiceAlertTargets`, el mismo helper — anti-divergencia), pero
 * nunca llama a `PushSender.send` — solo conteos, cero efectos.
 */
export class PreviewPushServiceAlert {
  constructor(
    private readonly tokens: Pick<PortalPushTokenRepository, 'listServiceAlertTargets'>,
    private readonly segments: Pick<CampaignSegmentSource, 'listSegmentRecipients'>,
  ) {}

  async execute(input: PreviewPushServiceAlertInput): Promise<PreviewPushServiceAlertResult> {
    const targets = await resolvePushServiceAlertTargets(this.segments, this.tokens, input.networkSiteId);
    return {
      recipients: targets.length,
      devices: targets.reduce((sum, t) => sum + t.tokens.length, 0),
    };
  }
}
