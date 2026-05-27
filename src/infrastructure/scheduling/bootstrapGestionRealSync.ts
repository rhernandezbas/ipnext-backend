import { config } from '../config';
import { GestionRealClient } from '../adapters/gestion-real/GestionRealClient';
import { PrismaClientMirrorRepository } from '../adapters/prisma/PrismaClientMirrorRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { SyncGestionRealClients } from '@application/use-cases/SyncGestionRealClients';
import { SyncGestionRealContracts } from '@application/use-cases/SyncGestionRealContracts';
import { RefreshDebtorBalances } from '@application/use-cases/RefreshDebtorBalances';
import { GestionRealSyncScheduler } from './GestionRealSyncScheduler';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';

/**
 * Composition root for the GR mirror sync. Returns a ready-to-start scheduler,
 * or null when the feature is off or misconfigured — callers just no-op on null,
 * so flipping GR_SYNC_ENABLED=false leaves the server behaving exactly as before.
 */
export function bootstrapGestionRealSync(): GestionRealSyncScheduler | null {
  const gr = config.gestionReal;

  if (!gr.enabled) {
    console.log('[gr-sync] disabled (GR_SYNC_ENABLED != true)');
    return null;
  }
  if (!gr.cuit || !gr.secret) {
    console.warn('[gr-sync] enabled but GR_CUIT/GR_SECRET missing — not starting');
    return null;
  }

  const client = new GestionRealClient({ baseUrl: gr.baseUrl, cuit: gr.cuit, secret: gr.secret });
  const mirror = new PrismaClientMirrorRepository();
  const state = new PrismaSyncStateRepository();
  const syncClients = new SyncGestionRealClients(client, mirror, state, { estados: gr.estados });
  const syncContracts = new SyncGestionRealContracts(client, mirror);
  const refreshDebtorBalances = new RefreshDebtorBalances(client, mirror, state);
  // PgAdvisoryLock uses a dedicated pg.Client (not the pool) so that session
  // advisory locks are tied to one stable connection across acquire/release.
  const lock = new PgAdvisoryLock();

  const scheduler = new GestionRealSyncScheduler(syncClients, syncContracts, { intervalMs: gr.intervalMs }, lock);

  // Batch debtor balance refresh — runs on its own interval (default 1h), independently.
  startBalanceBatchJob(refreshDebtorBalances, gr.balanceBatchIntervalMs);

  return scheduler;
}

/** Start an independent interval job for refreshing debtor balances. */
function startBalanceBatchJob(uc: RefreshDebtorBalances, intervalMs: number): void {
  let inFlight = false;

  const run = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await uc.execute();
      console.log(`[gr-balance] batch done: refreshed=${result.refreshed}, errors=${result.errors}`);
    } catch (err) {
      console.error('[gr-balance] batch error:', (err as Error).message);
    } finally {
      inFlight = false;
    }
  };

  // Run immediately on startup, then on interval
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  if (timer.unref) timer.unref();
}
