import type { Campaign } from '@domain/entities/campaign';
import type { CampaignRepository } from '@domain/ports/CampaignRepository';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import { CampaignAlreadyFinishedError, CampaignNotFoundError } from '@domain/errors/messaging-bulk';

/** Estructural: cualquier ejecutor de envío de campaña (`SendCampaign` lo satisface). */
export interface CampaignSender {
  execute(input: { campaignId: string }): Promise<Campaign>;
}

/** Clave del lock distribuido: una campaña a la vez GLOBAL (design D5/§3.4, molde SERVICE_CUT_LOCK_KEY). */
export const CAMPAIGN_LOCK_KEY = 'messaging-campaign-send';

/**
 * CampaignRunner (T4.4, SEND-1) — shell fire-and-forget para el envío de
 * campañas, molde EXACTO `ServiceCutRunner`. `start()` es rápido (valida
 * estado + lock) y devuelve de inmediato; el trabajo pesado (`SendCampaign`,
 * recorrer recipients) corre en background, liberando el lock en `finally`.
 *
 * SEND-1: dos invocaciones concurrentes de `start()` sobre la MISMA campaña
 * (lock GLOBAL tomado) → la segunda `{accepted:false}`, sin correr un segundo
 * run. Una campaña ya `done` → rechaza con `CampaignAlreadyFinishedError` SIN
 * tomar el lock (no tiene sentido competir por él si ya sabemos que se va a
 * rechazar). Una campaña `running`/`pending` con el lock LIBRE (worker
 * reiniciado tras un crash) SÍ puede re-arrancar — `SendCampaign` es
 * resumible (SEND-6).
 *
 * ── fix wave (FIX-3): doble-envío por lock RE-ENTRANTE ──────────────────────
 * `PgAdvisoryLock` usa UNA sesión pg de por vida; los advisory locks de sesión
 * son RE-ENTRANTES: `pg_try_advisory_lock` devuelve `true` DE NUEVO si la misma
 * sesión ya lo tiene. Por eso un doble `POST /send` en la MISMA réplica pasaba
 * dos veces el lock → dos loops → DOBLE ENVÍO. El lock distribuido solo protege
 * ENTRE réplicas (sesiones pg distintas). Para el caso intra-réplica se agrega
 * un guard IN-PROCESS (`heldInProcess`): un check+add SÍNCRONO (sin `await` en
 * el medio) que refleja el lock GLOBAL — si esta instancia ya está corriendo un
 * envío, la segunda invocación devuelve `{accepted:false}` sin arrancar otro.
 * El lock distribuido sigue cubriendo el caso cross-réplica.
 */
export class CampaignRunner {
  /**
   * FIX-3 — guard in-process del lock GLOBAL. Mientras esta instancia corre un
   * envío, `heldInProcess` tiene la clave; una segunda `start()` en la misma
   * réplica (donde el pg advisory lock se re-adquiere solo) la ve y rechaza.
   */
  private readonly heldInProcess = new Set<string>();

  constructor(
    private readonly sendCampaign: CampaignSender,
    private readonly campaignRepo: CampaignRepository,
    private readonly lock: DistributedLock,
  ) {}

  async start(campaignId: string): Promise<{ accepted: boolean; done?: Promise<void> }> {
    const campaign = await this.campaignRepo.findById(campaignId);
    if (!campaign) throw new CampaignNotFoundError(campaignId);
    // SEND-1 escenario 2 — validar estado ANTES de competir por el lock.
    if (campaign.status === 'done') {
      throw new CampaignAlreadyFinishedError(campaignId);
    }

    // FIX-3 — guard in-process ANTES del lock. Check+add SÍNCRONO (ni un `await`
    // entre `has` y `add`) para que dos `start()` concurrentes de esta réplica no
    // pasen ambos. Refleja el lock GLOBAL: si ya corremos un envío acá, rechazar.
    // (El lock distribuido re-entrante NO frena esto solo — de ahí el guard.)
    if (this.heldInProcess.has(CAMPAIGN_LOCK_KEY)) return { accepted: false };
    this.heldInProcess.add(CAMPAIGN_LOCK_KEY);

    let acquired = false;
    try {
      acquired = await this.lock.tryAcquire(CAMPAIGN_LOCK_KEY);
    } catch (err) {
      this.heldInProcess.delete(CAMPAIGN_LOCK_KEY);
      throw err;
    }
    if (!acquired) {
      // Otra RÉPLICA tiene el lock (sesión pg distinta) → SEND-1 escenario 1.
      this.heldInProcess.delete(CAMPAIGN_LOCK_KEY);
      return { accepted: false };
    }

    try {
      await this.campaignRepo.update(campaignId, {
        status: 'running',
        startedAt: campaign.startedAt ?? new Date().toISOString(),
      });
    } catch (err) {
      this.heldInProcess.delete(CAMPAIGN_LOCK_KEY);
      await this.lock.release(CAMPAIGN_LOCK_KEY);
      throw err;
    }

    const done = this.run(campaignId).finally(async () => {
      this.heldInProcess.delete(CAMPAIGN_LOCK_KEY);
      try {
        await this.lock.release(CAMPAIGN_LOCK_KEY);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[CampaignRunner] lock release failed:', err instanceof Error ? err.message : err);
      }
    });
    // Fire-and-forget: no propagar rechazos al caller.
    void done.catch(() => {});
    return { accepted: true, done };
  }

  private async run(campaignId: string): Promise<void> {
    try {
      await this.sendCampaign.execute({ campaignId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[CampaignRunner] send failed:', err instanceof Error ? err.message : err);
      await this.campaignRepo.update(campaignId, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date().toISOString(),
      });
    }
  }
}
