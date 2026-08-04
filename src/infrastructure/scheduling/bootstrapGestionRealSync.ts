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
import { RefreshDebtorBalances, FAST_LANE, SLOW_LANE } from '@application/use-cases/RefreshDebtorBalances';
import { runBalanceLaneTick, LaneGuard } from './balanceLaneTick';
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
  // Dos CARRILES de refresco de balances/facturas (change `gr-balance-refresh-lanes`):
  //   RÁPIDO (cada hora): activos + deudores + inactivos + incobrables — la data que el
  //     cliente mira en la app. Antes los ACTIVOS quedaban afuera y una factura ya pagada
  //     les quedaba `pendiente` para siempre.
  //   LENTO (1×/día de madrugada): las Bajas, que son el 62% del volumen y cuya deuda
  //     está congelada.
  // El carril va EXPLÍCITO — el use case no tiene default a propósito.
  const refreshFastLane = new RefreshDebtorBalances(client, mirror, state, FAST_LANE);
  const refreshSlowLane = new RefreshDebtorBalances(client, mirror, state, SLOW_LANE);
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

  // Refresco de balances — un ÚNICO ticker para los dos carriles (default 1h).
  startBalanceLaneJobs({
    fast: refreshFastLane,
    slow: refreshSlowLane,
    state,
    intervalMs: gr.balanceBatchIntervalMs,
  });

  return scheduler;
}

/**
 * Un solo ticker horario que alterna entre los dos carriles.
 *
 * Deliberadamente NO son dos `setInterval` independientes: el carril lento tarda
 * ~70 min y el rápido ~43, así que dos tickers los solaparían y duplicarían la
 * carga instantánea sobre GR (riesgo de 429s, ya advertido en el use case). Un
 * ticker con un guard compartido = exclusión mutua por construcción.
 *
 * Qué carril corre en cada tick lo decide `runBalanceLaneTick`, que está en su
 * propio módulo justamente para poder testearlo sin timers.
 */
function startBalanceLaneJobs(deps: {
  fast: RefreshDebtorBalances;
  slow: RefreshDebtorBalances;
  state: PrismaSyncStateRepository;
  intervalMs: number;
}): void {
  // Parámetros NOMBRADOS a propósito: `fast` y `slow` son del MISMO tipo, así que
  // como posicionales se podían invertir sin que el compilador ni ningún test se
  // dieran cuenta — y con los carriles cruzados el batch de Bajas (70 min) correría
  // cada hora y el de activos 1 vez por día, o sea el bug original de vuelta.
  // Con un objeto, invertirlos es imposible.
  const { fast, slow, state, intervalMs } = deps;
  const guard: LaneGuard = { inFlight: false };
  const tick = () => runBalanceLaneTick({ fast, slow, state, guard, now: () => new Date() });

  // Corre una vez al arrancar, después por intervalo.
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  if (timer.unref) timer.unref();
}
