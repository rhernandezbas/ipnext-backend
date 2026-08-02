import type { CampaignSegmentSource, CampaignSegmentFilter } from '@domain/ports/CustomerRepository';
import type { PortalPushTokenRepository, PushServiceAlertTarget } from '@domain/ports/PortalPushTokenRepository';

/**
 * resolvePushServiceAlertTargets — helper COMPARTIDO por `SendPushServiceAlert`
 * y `PreviewPushServiceAlert` (portal-push-notifications).
 *
 * `networkSiteId` ausente/null: universo completo (todas las cuentas con
 * `serviceAlerts=true` y >=1 token vivo). Con `networkSiteId`: reusa el MISMO
 * motor de segmentos que las campañas de mensajería/promos
 * (`listSegmentRecipients`, `statuses: []` = sin filtro de estado — SOLO nodo)
 * para resolver "qué clientes tienen >=1 contrato vigente en este nodo", y
 * restringe el target a esos `clientId`.
 *
 * Extraído como función pura compartida — mismo criterio "anti-divergencia"
 * que `buildSegmentWhere`/`buildClientMatchesSegmentWhere` (portal-promos): el
 * preview del operador (`PreviewPushServiceAlert`) y el envío real
 * (`SendPushServiceAlert`) NO pueden resolver el universo de destinatarios
 * con dos caminos separados sin arriesgarse a divergir en silencio.
 */
export async function resolvePushServiceAlertTargets(
  segments: Pick<CampaignSegmentSource, 'listSegmentRecipients'>,
  tokens: Pick<PortalPushTokenRepository, 'listServiceAlertTargets'>,
  networkSiteId?: string | null,
): Promise<PushServiceAlertTarget[]> {
  let clientIds: string[] | undefined;
  if (networkSiteId) {
    const segment: CampaignSegmentFilter = { statuses: [], networkSiteId };
    const candidates = await segments.listSegmentRecipients(segment);
    clientIds = candidates.map((c) => c.clientId);
  }
  return tokens.listServiceAlertTargets(clientIds);
}
