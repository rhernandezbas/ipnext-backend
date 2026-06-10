import { config } from '../config';
import { UispClient } from '../adapters/uisp/UispClient';
import { PrismaUispSiteRepository } from '../adapters/prisma/PrismaUispSiteRepository';
import { PrismaUispDeviceRepository } from '../adapters/prisma/PrismaUispDeviceRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { SyncUispMirror } from '@application/use-cases/SyncUispMirror';
import { UispSyncScheduler } from './UispSyncScheduler';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';

/**
 * Composition root for the UISP mirror sync scheduler.
 *
 * Returns null when UISP_BASE_URL or UISP_TOKEN are absent — cron stays dormant
 * and the scheduler logs "[uisp-sync] skipped — not configured" on each tick.
 * This keeps the feature dark by default; no env vars → no network calls.
 *
 * @param intervalMs - Tick interval. main.ts passes 300_000 (5 min fixed in V1).
 */
export async function bootstrapUispSync(intervalMs: number): Promise<UispSyncScheduler> {
  const { baseUrl, token } = config.uisp;

  let syncUseCase: SyncUispMirror | null = null;

  if (baseUrl && token) {
    const uispClient = new UispClient({ baseUrl, token });
    const siteRepo = new PrismaUispSiteRepository();
    const deviceRepo = new PrismaUispDeviceRepository();
    const syncStateRepo = new PrismaSyncStateRepository();
    syncUseCase = new SyncUispMirror(uispClient, siteRepo, deviceRepo, syncStateRepo);
  } else {
    console.warn('[uisp-sync] UISP_BASE_URL/UISP_TOKEN missing — sync will be skipped on each tick');
  }

  const flags = new PrismaFeatureFlagRepository();
  const lock = new PgAdvisoryLock();
  // FIX-2a: pass syncStateRepo so errors are persisted and visible in GetUispSyncStatus
  const schedulerSyncStateRepo = new PrismaSyncStateRepository();

  return new UispSyncScheduler(syncUseCase, flags, lock, { intervalMs }, schedulerSyncStateRepo);
}
