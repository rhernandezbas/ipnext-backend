import { config } from '../config';
import { IClassClient } from '../adapters/iclass/IClassClient';
import { PrismaIClassTeamRepository } from '../adapters/prisma/PrismaIClassTeamRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { SyncIClassTeams } from '@application/use-cases/SyncIClassTeams';
import { IClassTeamSyncScheduler } from './IClassTeamSyncScheduler';

/**
 * Composition root for the IClass team catalog auto-sync scheduler (#134).
 *
 * Returns null when IClass credentials are missing — same criterion as
 * bootstrapIClassClosure/bootstrapTeamLocationIngest. Otherwise starts dormant:
 * the scheduler re-reads the `iclass-team-sync` feature flag (default OFF) on
 * every tick, so it only runs once an operator flips the flag on.
 *
 * @param intervalMs - Tick interval. Default `config.iclassTeamSync.intervalMs`
 *   (6h by default, env-configurable via ICLASS_TEAM_SYNC_INTERVAL_MS, floor 15min / ceiling 24h).
 */
export async function bootstrapIClassTeamSync(
  intervalMs: number = config.iclassTeamSync.intervalMs,
): Promise<IClassTeamSyncScheduler | null> {
  const { baseUrl, username, password, thirdPartyId } = config.iclass;
  if (!username || !password || !thirdPartyId) {
    console.warn('[iclass-team-sync] ICLASS_USERNAME/PASSWORD/THIRD_PARTY_ID missing — not starting');
    return null;
  }

  const iclass = new IClassClient({ baseUrl, username, password, thirdPartyId });
  const sync = new SyncIClassTeams(iclass, new PrismaIClassTeamRepository());
  const flags = new PrismaFeatureFlagRepository();
  const lock = new PgAdvisoryLock();

  return new IClassTeamSyncScheduler(sync, flags, { intervalMs }, lock);
}
