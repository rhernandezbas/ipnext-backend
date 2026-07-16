import { config } from '../config';
import { UispClient } from '../adapters/uisp/UispClient';
import { PrismaUispSiteRepository } from '../adapters/prisma/PrismaUispSiteRepository';
import { PrismaUispDeviceRepository } from '../adapters/prisma/PrismaUispDeviceRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PrismaNetworkSiteRepository } from '../adapters/prisma/PrismaNetworkSiteRepository';
import { PrismaAccessPointRepository } from '../adapters/prisma/PrismaAccessPointRepository';
import { PrismaPppoeServiceRepository } from '../adapters/prisma/PrismaPppoeServiceRepository';
import { PrismaRadiusEventRepository } from '../adapters/prisma/PrismaRadiusEventRepository';
import { PrismaContractRepository } from '../adapters/prisma/PrismaContractRepository';
import { SyncUispMirror } from '@application/use-cases/SyncUispMirror';
import { AutoAssignContractNetwork } from '@application/use-cases/AutoAssignContractNetwork';
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
  // contract-node-ap-auto-assign (AA-5) — only meaningful when the mirror is configured (the
  // scheduler already short-circuits on sync===null before ever reaching the auto-assign step,
  // so building it only in this branch is not a behavior gap, just avoids a dead instance).
  let autoAssignUseCase: AutoAssignContractNetwork | undefined;

  if (baseUrl && token) {
    const uispClient = new UispClient({ baseUrl, token });
    const siteRepo = new PrismaUispSiteRepository();
    const deviceRepo = new PrismaUispDeviceRepository();
    const syncStateRepo = new PrismaSyncStateRepository();
    const networkSiteRepo = new PrismaNetworkSiteRepository();
    const accessPointRepo = new PrismaAccessPointRepository();
    syncUseCase = new SyncUispMirror(uispClient, siteRepo, deviceRepo, syncStateRepo, networkSiteRepo, accessPointRepo);

    const pppoeRepo = new PrismaPppoeServiceRepository();
    const radiusEventRepo = new PrismaRadiusEventRepository();
    const contractRepo = new PrismaContractRepository();
    const autoAssignSyncStateRepo = new PrismaSyncStateRepository();
    autoAssignUseCase = new AutoAssignContractNetwork(
      pppoeRepo,
      radiusEventRepo,
      deviceRepo,
      accessPointRepo,
      contractRepo,
      autoAssignSyncStateRepo,
    );
  } else {
    console.warn('[uisp-sync] UISP_BASE_URL/UISP_TOKEN missing — sync will be skipped on each tick');
  }

  const flags = new PrismaFeatureFlagRepository();
  const lock = new PgAdvisoryLock();
  // FIX-2a: pass syncStateRepo so errors are persisted and visible in GetUispSyncStatus
  const schedulerSyncStateRepo = new PrismaSyncStateRepository();

  return new UispSyncScheduler(syncUseCase, flags, lock, { intervalMs }, schedulerSyncStateRepo, autoAssignUseCase);
}
