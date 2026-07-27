import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PrismaTeamLocationRepository } from '../adapters/prisma/PrismaTeamLocationRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { IngestTeamLocations } from '@application/use-cases/IngestTeamLocations';
import { buildTeamLocationSource } from '../http/iclass.factory';
import {
  TeamLocationIngestScheduler,
  DEFAULT_INGEST_INTERVAL_MS,
} from './TeamLocationIngestScheduler';

/**
 * Composition root del ingest de breadcrumbs GPS (change `iclass-gps-audit`).
 *
 * Devuelve `null` si faltan credenciales de IClass. Si están, arranca DORMIDO: el
 * scheduler re-lee el flag `iclass-gps-ingest` (default OFF) en cada tick, así que no
 * ingesta nada hasta que un operador lo prenda. Mismo criterio que el closure loop y
 * que `pppoe-auto-move`.
 *
 * @param intervalMs — default 6 h. IClass retiene ~30 días, así que aun con varias
 *        corridas fallidas seguidas sobra margen antes de perder dato.
 */
export async function bootstrapTeamLocationIngest(
  intervalMs: number = DEFAULT_INGEST_INTERVAL_MS,
): Promise<TeamLocationIngestScheduler | null> {
  const source = buildTeamLocationSource();
  if (!source) {
    console.warn('[gps-ingest] ICLASS_USERNAME/PASSWORD/THIRD_PARTY_ID missing — not starting');
    return null;
  }

  const ingest = new IngestTeamLocations({
    source,
    repo: new PrismaTeamLocationRepository(),
  });

  return new TeamLocationIngestScheduler(
    ingest,
    new PrismaFeatureFlagRepository(),
    { intervalMs },
    new PgAdvisoryLock(),
  );
}
