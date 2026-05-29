import { config } from '../config';
import { GestionRealClient } from '../adapters/gestion-real/GestionRealClient';
import { PrismaGrLinkResolver } from '../adapters/prisma/PrismaGrLinkResolver';
import { PrismaGestionRealIngestConfigRepository } from '../adapters/prisma/PrismaGestionRealIngestConfigRepository';
import { PrismaSchedulingRepository } from '../adapters/prisma/PrismaSchedulingRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaProjectRepository } from '../adapters/prisma/PrismaProjectRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { IngestGestionRealOrders } from '@application/use-cases/IngestGestionRealOrders';
import { GestionRealIngestScheduler } from './GestionRealIngestScheduler';

const PENDING_STAGE_NAME = 'Pendiente';

/**
 * Composition root for the GR installation-order ingest. Returns a ready-to-start
 * scheduler, or null when GR credentials are missing — callers just no-op on null,
 * exactly like `bootstrapGestionRealSync`.
 *
 * The on/off decision lives in the persisted `GestionRealIngestConfig.enabled`
 * flag (checked per tick at runtime, not at bootstrap), so an operator can flip
 * it via `PUT /api/gestion-real-ingest/config` without a redeploy. We still gate
 * the bootstrap on GR credentials being present — without them the upstream
 * `getServiceOrders` call cannot authenticate.
 */
export async function bootstrapGestionRealIngest(): Promise<GestionRealIngestScheduler | null> {
  const gr = config.gestionReal;

  if (!gr.enabled) {
    console.log('[gr-ingest] disabled (GR_SYNC_ENABLED != true)');
    return null;
  }
  if (!gr.cuit || !gr.secret) {
    console.warn('[gr-ingest] enabled but GR_CUIT/GR_SECRET missing — not starting');
    return null;
  }

  const client = new GestionRealClient({ baseUrl: gr.baseUrl, cuit: gr.cuit, secret: gr.secret });
  const resolver = new PrismaGrLinkResolver();
  const ingestConfig = new PrismaGestionRealIngestConfigRepository();
  const scheduling = new PrismaSchedulingRepository();
  const state = new PrismaSyncStateRepository();
  const projects = new PrismaProjectRepository();
  // Master switch (release flag), checked per run inside the use case.
  const featureFlags = new PrismaFeatureFlagRepository();

  // Resolve a last-resort default stage. The use-case resolves the real
  // "Pendiente" stage per project workflow at runtime; this is only the fallback
  // when neither a project- nor a global-scoped "Pendiente" stage is found.
  const defaultStage = await scheduling.getStageByName(PENDING_STAGE_NAME);
  const defaultStageId = defaultStage?.id ?? '';
  if (!defaultStageId) {
    console.warn('[gr-ingest] no global "Pendiente" stage found — needs-review tasks may fail to create until one exists');
  }

  const ingest = new IngestGestionRealOrders(
    client,
    resolver,
    scheduling,
    ingestConfig,
    state,
    projects,
    featureFlags,
    { defaultStageId },
  );

  // PgAdvisoryLock uses a dedicated pg.Client so session advisory locks stay
  // tied to one stable connection across acquire/release.
  const lock = new PgAdvisoryLock();

  // Read the persisted interval; defaults apply when the row is absent.
  const persisted = await ingestConfig.get();

  return new GestionRealIngestScheduler(ingest, ingestConfig, { intervalMs: persisted.intervalMs }, lock);
}
