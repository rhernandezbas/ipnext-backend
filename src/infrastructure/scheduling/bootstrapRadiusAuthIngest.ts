/**
 * bootstrapRadiusAuthIngest — composition root del scheduler de auth RADIUS (radpostauth).
 *
 * Espejo de bootstrapRadiusAccountingIngest. Retorna null cuando ORCHESTRATOR_BASE_URL no está
 * configurado (opt-in): el scheduler nunca arranca y los ticks son no-ops.
 */
import { config } from '../config';
import { HttpRadiusOrchestratorGateway } from '../adapters/orchestrator/HttpRadiusOrchestratorGateway';
import { PrismaRadiusAuthEventRepository } from '../adapters/prisma/PrismaRadiusAuthEventRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { IngestRadiusAuth } from '@application/use-cases/IngestRadiusAuth';
import { RadiusAuthIngestScheduler } from './RadiusAuthIngestScheduler';

/**
 * @param intervalMs - Intervalo de tick. main.ts pasa 300_000 (5 min).
 * @returns Scheduler listo para .start(), o null si el orchestrator no está configurado.
 */
export async function bootstrapRadiusAuthIngest(
  intervalMs = 300_000,
): Promise<RadiusAuthIngestScheduler | null> {
  const { baseUrl, token } = config.orchestrator;

  if (!baseUrl) {
    console.warn('[radius-auth-ingest] ORCHESTRATOR_BASE_URL missing -- scheduler disabled');
    return null;
  }

  const gateway   = new HttpRadiusOrchestratorGateway({ baseUrl, token, timeoutMs: config.orchestrator.timeoutMs });
  const eventRepo = new PrismaRadiusAuthEventRepository();
  const stateRepo = new PrismaSyncStateRepository();
  const flags     = new PrismaFeatureFlagRepository();
  const lock      = new PgAdvisoryLock();

  const ingest = new IngestRadiusAuth(gateway, eventRepo, stateRepo);

  return new RadiusAuthIngestScheduler(ingest, { intervalMs }, lock, flags, stateRepo);
}
