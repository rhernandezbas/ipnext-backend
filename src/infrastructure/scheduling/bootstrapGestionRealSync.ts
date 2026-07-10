import { config } from '../config';
import { GestionRealClient } from '../adapters/gestion-real/GestionRealClient';
import { PrismaClientMirrorRepository } from '../adapters/prisma/PrismaClientMirrorRepository';
import { PrismaClientMirrorReadRepository } from '../adapters/prisma/PrismaClientMirrorReadRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaGestionRealSyncConfigRepository } from '../adapters/prisma/PrismaGestionRealSyncConfigRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PrismaOwnershipCaseRepository } from '../adapters/prisma/PrismaOwnershipCaseRepository';
import { PrismaContractPairingReader } from '../adapters/prisma/PrismaContractPairingReader';
import { SyncGestionRealClients } from '@application/use-cases/SyncGestionRealClients';
import { SyncGestionRealContracts } from '@application/use-cases/SyncGestionRealContracts';
import { SyncGestionRealContractsDelta } from '@application/use-cases/SyncGestionRealContractsDelta';
import { BackfillGrContractsBatch } from '@application/use-cases/BackfillGrContractsBatch';
import { RefreshDebtorBalances } from '@application/use-cases/RefreshDebtorBalances';
import { DetectOwnershipTransferCases } from '@application/use-cases/actions/DetectOwnershipTransferCases';
import { GestionRealSyncScheduler } from './GestionRealSyncScheduler';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';

/**
 * Composition root for the GR mirror sync. Returns a ready-to-start scheduler,
 * or null when the feature is off or misconfigured — callers just no-op on null,
 * so flipping GR_SYNC_ENABLED=false leaves the server behaving exactly as before.
 *
 * `intervalMs` and `estados` are read ONCE from the DB-backed config repo (env as
 * the ultimate fallback via the repo's default record); the runtime on/off gate
 * is the `gestion-real-sync` feature flag, re-read per tick inside the use-case.
 * Async because resolving the persisted config is an I/O call.
 */
export async function bootstrapGestionRealSync(): Promise<GestionRealSyncScheduler | null> {
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
  const syncConfig = new PrismaGestionRealSyncConfigRepository();
  // Master switch (release flag), checked per run inside the use case.
  const featureFlags = new PrismaFeatureFlagRepository();

  // Read the persisted config ONCE; the repo's defaults converge with the env
  // fallback (config.gestionReal.intervalMs/.estados) when no row exists.
  const persisted = await syncConfig.get();

  const syncClients = new SyncGestionRealClients(client, mirror, state, featureFlags, { estados: persisted.estados });
  const syncContracts = new SyncGestionRealContracts(client, mirror);
  const refreshDebtorBalances = new RefreshDebtorBalances(client, mirror, state);
  // Resumable, bounded contract backfill driven one batch per scheduler tick
  // (default batchSize 150). Enumerates the local client universe via the
  // read-only mirror port; reuses the contract fetch+upsert path.
  const mirrorRead = new PrismaClientMirrorReadRepository();
  const backfill = new BackfillGrContractsBatch(mirrorRead, syncContracts, state);
  // Global contract delta by modification date — runs AFTER client-sync each tick
  // so newly-created clients are already in the mirror (closes titularidad gap).
  const syncContractsDelta = new SyncGestionRealContractsDelta(client, mirror, state, featureFlags);
  // Ownership-transfer case detector (actions-worklist DET-1) — scans the mirror
  // AFTER the delta each tick and opens cases for titularity bajas (idempotent).
  const detectOwnershipCases = new DetectOwnershipTransferCases(
    new PrismaOwnershipCaseRepository(),
    new PrismaContractPairingReader(),
  );
  // PgAdvisoryLock uses a dedicated pg.Client (not the pool) so that session
  // advisory locks are tied to one stable connection across acquire/release.
  const lock = new PgAdvisoryLock();

  const scheduler = new GestionRealSyncScheduler(syncClients, syncContracts, { intervalMs: persisted.intervalMs }, lock, backfill, syncContractsDelta, detectOwnershipCases);

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
