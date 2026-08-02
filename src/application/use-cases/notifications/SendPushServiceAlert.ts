import type { CampaignSegmentSource } from '@domain/ports/CustomerRepository';
import type { PortalPushTokenRepository } from '@domain/ports/PortalPushTokenRepository';
import type { PushSender } from '@domain/ports/PushSender';
import { resolvePushServiceAlertTargets } from './resolvePushServiceAlertTargets';

export interface SendPushServiceAlertInput {
  title: string;
  body: string;
  /** Ausente/null = a TODOS los opt-in con token vivo (sin segmentación). */
  networkSiteId?: string | null;
}

export interface SendPushServiceAlertResult {
  /** Cuentas destinatarias (>=1 token vivo, serviceAlerts=true) — conteo REAL, no estimado. */
  recipients: number;
  /** Tokens a los que se intentó mandar (suma de dispositivos de `recipients`). */
  devices: number;
  /** Cuántos de esos tokens FCM reportó muertos en ESTE envío (ya quedaron `invalidAt`). */
  invalidated: number;
  /** `true` cuando `PushSender` es un stub (sin Firebase configurado) — nada se mandó de verdad. */
  dryRun: boolean;
}

/**
 * SendPushServiceAlert — admin, `POST /api/notifications/push-service-alert`
 * (portal-push-notifications). Avisos de SERVICIO únicamente (transaccional,
 * proposal §1) — el envío de PROMOCIONES queda explícitamente FUERA de este
 * change (sale en una fase siguiente, cuando el lado app de la app de
 * clientes exista); la preferencia `promos` ya existe y es auditable
 * (`PortalPushPreference`), pero nada la usa para enviar todavía.
 *
 * `recipients`/`devices`/`invalidated` son conteos REALES (nunca estimados):
 * salen de resolver el universo de destinatarios de verdad, no de una
 * proyección — mismo criterio que `PreviewPromoAudience`.
 */
export class SendPushServiceAlert {
  constructor(
    private readonly tokens: Pick<PortalPushTokenRepository, 'listServiceAlertTargets' | 'markInvalid'>,
    private readonly sender: PushSender,
    private readonly segments: Pick<CampaignSegmentSource, 'listSegmentRecipients'>,
  ) {}

  async execute(input: SendPushServiceAlertInput): Promise<SendPushServiceAlertResult> {
    const targets = await resolvePushServiceAlertTargets(this.segments, this.tokens, input.networkSiteId);
    const allTokens = targets.flatMap((t) => t.tokens);

    let invalidTokens: string[] = [];
    if (allTokens.length > 0) {
      const result = await this.sender.send(allTokens, { title: input.title, body: input.body });
      invalidTokens = result.invalidTokens;
      if (invalidTokens.length > 0) {
        await this.tokens.markInvalid(invalidTokens);
      }
    }

    return {
      recipients: targets.length,
      devices: allTokens.length,
      invalidated: invalidTokens.length,
      dryRun: this.sender.dryRun === true,
    };
  }
}
