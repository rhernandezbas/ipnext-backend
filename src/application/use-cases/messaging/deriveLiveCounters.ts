import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { Campaign } from '@domain/entities/campaign';

export interface LiveCounters {
  sentCount: number;
  failedCount: number;
  skippedCount: number;
  optedOutCount: number;
}

/**
 * messaging-bulk fix wave 3 (FIX-6-v2) — helper compartido por `GetCampaign` y
 * `ListCampaigns`. Deriva los contadores por-status EN VIVO desde los recipients
 * REALES (`listRecipients(...).total`, `limit:1` — solo interesa el `.total`, no
 * las filas) en vez del snapshot del header, que solo se escribe en
 * `SendCampaign.finalize` (al cierre). Así el detalle Y la lista muestran el
 * MISMO progreso durante un envío, sin divergir (el detalle en avance, la lista
 * en 0). Molde EXACTO del `Promise.all` que ya usaban `GetCampaign` y `finalize`.
 */
export async function deriveLiveCounters(
  campaignRepo: CampaignRepository,
  campaignId: string,
): Promise<LiveCounters> {
  const [sent, failed, skipped, optedOut] = await Promise.all([
    campaignRepo.listRecipients(campaignId, { statusIn: ['sent'], limit: 1 }),
    campaignRepo.listRecipients(campaignId, { statusIn: ['failed'], limit: 1 }),
    campaignRepo.listRecipients(campaignId, { statusIn: ['skipped'], limit: 1 }),
    campaignRepo.listRecipients(campaignId, { statusIn: ['opted_out'], limit: 1 }),
  ]);
  return {
    sentCount: sent.total,
    failedCount: failed.total,
    skippedCount: skipped.total,
    optedOutCount: optedOut.total,
  };
}

/**
 * `true` si el header de la campaña tiene contadores POTENCIALMENTE stale y hay
 * que derivarlos en vivo. Solo las campañas EN VUELO (`running`/`paused`) tienen
 * el snapshot del header sin actualizar (se escribe recién en `finalize`); una
 * `done` ya tiene los contadores REALES persistidos por `finalize` (idénticos a
 * la derivación en vivo), una `failed` abortó con recipients aún `queued`
 * (contadores 0 correctos) y una `pending` es genuinamente 0. Derivar solo las
 * in-flight ACOTA el costo: el lock GLOBAL de envío (`CAMPAIGN_LOCK_KEY`) permite
 * UNA campaña corriendo a la vez, así que esto NO es N+1 sobre una página de
 * historial — a lo sumo ~1 campaña de la página gatilla las 4 queries de conteo.
 */
export function needsLiveCounters(status: Campaign['status']): boolean {
  return status === 'running' || status === 'paused';
}
