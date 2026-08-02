import type { CampaignSegmentSource, CampaignSegmentFilter } from '@domain/ports/CustomerRepository';
import type { PortalPushTokenRepository, PushServiceAlertTarget } from '@domain/ports/PortalPushTokenRepository';

/**
 * resolvePushServiceAlertTargets — helper COMPARTIDO por `SendPushServiceAlert`
 * y `PreviewPushServiceAlert` (portal-push-notifications).
 *
 * `networkSiteId` ausente/null: universo completo (todas las cuentas con >=1
 * token en `serviceAlerts=true` y vivo — push-per-device, el filtro es por
 * TOKEN, no por cuenta). Con `networkSiteId`: reusa el MISMO
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
  const clientIds = await resolveServiceAlertClientIds(segments, networkSiteId);
  return tokens.listServiceAlertTargets(clientIds);
}

/**
 * resolveServiceAlertClientIds — extraído de `resolvePushServiceAlertTargets`
 * (portal-notification-inbox) para que `SendPushServiceAlert` pueda resolver
 * el MISMO filtro de nodo una sola vez y reusarlo tanto para
 * `listServiceAlertTargets` (push real) como para `listServiceAlertAccounts`
 * (buzón) — anti-divergencia, un solo camino de segmentación para las dos
 * consultas del mismo envío.
 */
export async function resolveServiceAlertClientIds(
  segments: Pick<CampaignSegmentSource, 'listSegmentRecipients'>,
  networkSiteId?: string | null,
): Promise<string[] | undefined> {
  if (!networkSiteId) return undefined;
  const segment: CampaignSegmentFilter = { statuses: [], networkSiteId };
  const candidates = await segments.listSegmentRecipients(segment);
  return candidates.map((c) => c.clientId);
}
