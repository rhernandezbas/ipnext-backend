import type { CampaignSegmentSource } from '@domain/ports/CustomerRepository';
import type { PortalPushTokenRepository } from '@domain/ports/PortalPushTokenRepository';
import type { PushSender } from '@domain/ports/PushSender';
import type { PortalNotificationRepository } from '@domain/ports/PortalNotificationRepository';
import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import { resolveServiceAlertClientIds } from './resolvePushServiceAlertTargets';

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
  /**
   * portal-notification-inbox — cuántas filas `PortalNotification` se
   * crearon con éxito. Universo TOTAL del filtro de nodo (TODAS las cuentas
   * del segmento, sin mirar `serviceAlerts` — ver el docblock de la clase),
   * casi siempre >= `recipients`.
   */
  inboxed: number;
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
 *
 * portal-notification-inbox — TIMBRE vs REGISTRO (decisión explícita, no
 * "arreglar" agregando un filtro de `serviceAlerts` acá abajo):
 *   - El PUSH (arriba, `this.tokens.listServiceAlertTargets`) SÍ filtra por
 *     `serviceAlerts` — push-per-device: esa preferencia es POR DISPOSITIVO
 *     (una cuenta de portal puede ser compartida por una familia, cada
 *     teléfono es una persona distinta) y controla si ESE teléfono suena. Una
 *     cuenta con 2 dispositivos, uno con `serviceAlerts=false`, le llega a
 *     UNO solo — `devices` cuenta tokens, `recipients` cuenta las cuentas
 *     distintas con >=1 token calificado.
 *   - El BUZÓN (`this.accounts.listByClientIds`) NO mira `serviceAlerts`:
 *     escribe una fila `PortalNotification` para TODA cuenta del
 *     segmento/nodo del aviso. Que ningún teléfono haya sonado no significa
 *     que el aviso no exista — el buzón es justamente el registro/respaldo,
 *     independiente de si algún dispositivo lo hizo sonar.
 * La escritura del buzón NUNCA tumba el envío: si el insert de una cuenta
 * falla, se loguea y se sigue con la siguiente (el push ya salió antes de
 * este paso).
 */
export class SendPushServiceAlert {
  constructor(
    private readonly tokens: Pick<PortalPushTokenRepository, 'listServiceAlertTargets' | 'markInvalid'>,
    private readonly sender: PushSender,
    private readonly segments: Pick<CampaignSegmentSource, 'listSegmentRecipients'>,
    private readonly notifications: Pick<PortalNotificationRepository, 'create'>,
    private readonly accounts: Pick<PortalAccountRepository, 'listByClientIds'>,
  ) {}

  async execute(input: SendPushServiceAlertInput): Promise<SendPushServiceAlertResult> {
    const clientIds = await resolveServiceAlertClientIds(this.segments, input.networkSiteId);

    const targets = await this.tokens.listServiceAlertTargets(clientIds);
    const allTokens = targets.flatMap((t) => t.tokens);

    let invalidTokens: string[] = [];
    if (allTokens.length > 0) {
      const result = await this.sender.send(allTokens, { title: input.title, body: input.body });
      invalidTokens = result.invalidTokens;
      if (invalidTokens.length > 0) {
        await this.tokens.markInvalid(invalidTokens);
      }
    }

    const inboxAccounts = await this.accounts.listByClientIds(clientIds);
    let inboxed = 0;
    for (const account of inboxAccounts) {
      try {
        await this.notifications.create({
          accountId: account.accountId,
          channel: 'service',
          title: input.title,
          body: input.body,
        });
        inboxed++;
      } catch (err) {
        // portal-notification-inbox — best-effort: el buzón nunca tumba el envío.
        console.error('[push-service-alert] no se pudo persistir PortalNotification para la cuenta', account.accountId, err);
      }
    }

    return {
      recipients: targets.length,
      devices: allTokens.length,
      invalidated: invalidTokens.length,
      dryRun: this.sender.dryRun === true,
      inboxed,
    };
  }
}
