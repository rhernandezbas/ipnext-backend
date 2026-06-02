import { config } from '../config';
import { GestionRealClient } from '../adapters/gestion-real/GestionRealClient';
import { PrismaGrLinkResolver } from '../adapters/prisma/PrismaGrLinkResolver';
import { PrismaGestionRealIngestConfigRepository } from '../adapters/prisma/PrismaGestionRealIngestConfigRepository';
import { PrismaSchedulingRepository } from '../adapters/prisma/PrismaSchedulingRepository';
import { PrismaSyncStateRepository } from '../adapters/prisma/PrismaSyncStateRepository';
import { PrismaProjectRepository } from '../adapters/prisma/PrismaProjectRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PrismaTaskPriorityRepository } from '../adapters/prisma/PrismaTaskPriorityRepository';
import { PrismaTaskCategoryRepository } from '../adapters/prisma/PrismaTaskCategoryRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { IngestGestionRealOrders } from '@application/use-cases/IngestGestionRealOrders';
import { GestionRealIngestScheduler } from './GestionRealIngestScheduler';

/**
 * Business code for the "needs-review" default stage.
 * NOTE: This stage does NOT exist in the canonical seed (the canonical entry stage
 * for the installation workflow is "nuevo"). If a "pendiente" stage exists in a
 * custom workflow it will be picked; otherwise `getInitialStage` is the real fallback.
 */
const PENDING_STAGE_CODE = 'pendiente';

/**
 * Composition root for the GR installation-order ingest. Returns a ready-to-start
 * scheduler, or null when GR credentials are missing — callers just no-op on null,
 * exactly like `bootstrapGestionRealSync`.
 *
 * The runtime on/off decision lives in the `gestion-real-ingest` feature flag
 * (checked per run inside the use-case), so an operator can flip it via
 * `/feature-flags` without a redeploy. We still gate the bootstrap on the
 * `GR_SYNC_ENABLED` env and GR credentials being present — without them the
 * upstream `getServiceOrders` call cannot authenticate.
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
  // Catalog repos: the ingest resolves "Normal"/"Instalación" from these at the
  // start of each run and BLOCKS (zero tasks) if either is missing.
  const priorities = new PrismaTaskPriorityRepository();
  const categories = new PrismaTaskCategoryRepository();

  // Resolve a last-resort default stage for the NEEDS-REVIEW (null-project) path.
  //
  // All CLASSIFIED orders resolve their stage at runtime via
  // `getInitialStage(workflowId)` on the target project's workflow (the installation
  // workflow entry stage is "nuevo", code `nuevo`), so they never depend on this default.
  // This fallback only matters for needs-review tasks (no project, no workflow).
  //
  // Resolution strategy (code-first, rename-safe):
  //   1. Get the configured fallback project's workflowId.
  //   2. Try getStageByCode(PENDING_STAGE_CODE, workflowId) — resolves if the workflow
  //      has a stage with code 'pendiente' (not in the canonical seed, but may exist
  //      in custom workflows).
  //   3. Fall back to getInitialStage(workflowId) — always returns the first stage by
  //      order (the real entry point for classified tasks too).
  //   4. Log a warning if neither resolves (no configured project).
  let defaultStageId = '';
  const persistedConfig = await ingestConfig.get();
  const fallbackProjectId =
    persistedConfig.fiberProjectId ?? persistedConfig.wirelessProjectId ?? null;
  if (fallbackProjectId) {
    const fallbackProject = await projects.get(fallbackProjectId);
    if (fallbackProject?.workflowId) {
      const wfId = fallbackProject.workflowId;
      // Try the dedicated pending stage by code first (rename-safe).
      defaultStageId =
        (await scheduling.getStageByCode(PENDING_STAGE_CODE, wfId))?.id ?? '';
      // Fall back to the initial stage of the workflow (always available).
      if (!defaultStageId) {
        defaultStageId =
          (await scheduling.getInitialStage(wfId))?.id ?? '';
      }
    }
  }
  if (!defaultStageId) {
    console.warn(
      `[gr-ingest] no stage with code '${PENDING_STAGE_CODE}' and no resolvable initial stage from configured projects — needs-review (null-project) tasks may fail to create until a default stage exists`,
    );
  }

  const ingest = new IngestGestionRealOrders(
    client,
    resolver,
    scheduling,
    ingestConfig,
    state,
    projects,
    featureFlags,
    priorities,
    categories,
    { defaultStageId },
  );

  // PgAdvisoryLock uses a dedicated pg.Client so session advisory locks stay
  // tied to one stable connection across acquire/release.
  const lock = new PgAdvisoryLock();

  // Read the persisted interval; defaults apply when the row is absent.
  const persisted = await ingestConfig.get();

  return new GestionRealIngestScheduler(ingest, { intervalMs: persisted.intervalMs }, lock);
}
