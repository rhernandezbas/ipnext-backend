/**
 * bootstrapRadiusAccountingIngest — composition root del scheduler de accounting RADIUS.
 *
 * Retorna null cuando ORCHESTRATOR_BASE_URL no esta configurado (opt-in, identico a
 * bootstrapUispSync). En ese caso el scheduler nunca arranca y los ticks son no-ops.
 *
 * spec.md REQ-BOOT-1 / REQ-BOOT-2
 */
import { config } from '../config';
import { HttpRadiusOrchestratorGateway } from '../adapters/orchestrator/HttpRadiusOrchestratorGateway';
import { PrismaRadiusEventRepository } from '../adapters/prisma/PrismaRadiusEventRepository';
import { PrismaNasRepository } from '../adapters/prisma/PrismaNasRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { IngestRadiusAccounting } from '@application/use-cases/IngestRadiusAccounting';
import { RadiusAccountingIngestScheduler } from './RadiusAccountingIngestScheduler';

/**
 * @param intervalMs - Intervalo de tick. main.ts pasa 300_000 (5 min).
 * @returns Scheduler listo para .start(), o null si el orchestrator no esta configurado.
 */
export async function bootstrapRadiusAccountingIngest(
  intervalMs = 300_000,
): Promise<RadiusAccountingIngestScheduler | null> {
  const { baseUrl, token } = config.orchestrator;

  if (!baseUrl) {
    console.warn('[radius-ingest] ORCHESTRATOR_BASE_URL missing -- scheduler disabled');
    return null;
  }

  const gateway = new HttpRadiusOrchestratorGateway({ baseUrl, token, timeoutMs: config.orchestrator.timeoutMs });
  const eventRepo  = new PrismaRadiusEventRepository();
  const nasRepo    = new PrismaNasRepository();
  const stateRepo  = new PrismaSyncStateRepository();
  const flags      = new PrismaFeatureFlagRepository();
  const lock       = new PgAdvisoryLock();

  const ingest = new IngestRadiusAccounting(gateway, eventRepo, nasRepo, stateRepo);

  return new RadiusAccountingIngestScheduler(ingest, { intervalMs }, lock, flags, stateRepo);
}
