/**
 * bootstrapAutoProvisionFiber — composition root del watcher full-auto de fibra
 * (K3 fiber-auto-watcher).
 *
 * Espejo de bootstrapRadiusAutoCure: retorna null cuando SMARTOLT_BASE_URL /
 * SMARTOLT_API_TOKEN no están configurados (opt-in, skip SILENCIOSO — sin SmartOLT no
 * hay ONUs que aprovisionar; el resto de la app arranca igual).
 *
 * ON/OFF: feature flag 'fiber-auto-provision-watcher' (seed OFF por migración,
 * SEPARADO del flag del wizard 'fiber-auto-provision'), chequeado POR TICK dentro del
 * scheduler — NO acá (prender/apagar no requiere restart).
 *
 * El wiring de ProvisionFiberOnu replica el del bloque /api/fiber de app.ts (misma
 * cadena K1: PregenInstallPppoe + CreatePppoeService + FindFreeIp): el watcher
 * aprovisiona EXACTAMENTE igual que el botón — solo cambia el origin del bloque.
 */
import { config } from '../config';
import { prisma } from '../database/prisma';
import { SmartOltHttpGateway } from '../adapters/smartolt/SmartOltHttpGateway';
import { PrismaSmartOltOltConfigRepository } from '../adapters/prisma/PrismaSmartOltOltConfigRepository';
import { PrismaPppoeServiceRepository } from '../adapters/prisma/PrismaPppoeServiceRepository';
import { PrismaNasRepository } from '../adapters/prisma/PrismaNasRepository';
import { PrismaIpNetworkRepository } from '../adapters/prisma/PrismaIpNetworkRepository';
import { PrismaServiceCatalogRepository } from '../adapters/prisma/PrismaServiceCatalogRepository';
import { PrismaContractServiceRepository } from '../adapters/prisma/PrismaContractServiceRepository';
import { PrismaContractServiceEventRepository } from '../adapters/prisma/PrismaContractServiceEventRepository';
import { PrismaGestionRealIngestConfigRepository } from '../adapters/prisma/PrismaGestionRealIngestConfigRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PrismaFiberAutoProvisionTaskRepository } from '../adapters/prisma/PrismaFiberAutoProvisionTaskRepository';
import { PrismaFiberAutoProvisionAttemptRepository } from '../adapters/prisma/PrismaFiberAutoProvisionAttemptRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { RouterOsGateway } from '../adapters/routeros/RouterOsGateway';
import { HttpRadiusOrchestratorGateway } from '../adapters/orchestrator/HttpRadiusOrchestratorGateway';
import { GestionRealClient } from '../adapters/gestion-real/GestionRealClient';
import { CreatePppoeService } from '@application/use-cases/CreatePppoeService';
import { EnsureInternetContractService } from '@application/use-cases/EnsureInternetContractService';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { PregenInstallPppoe } from '@application/use-cases/PregenInstallPppoe';
import {
  ProvisionFiberOnu,
  FiberContractSnapshot,
  FiberInstallTaskWriter,
} from '@application/use-cases/ProvisionFiberOnu';
import { AutoProvisionFiberOnus } from '@application/use-cases/AutoProvisionFiberOnus';
import { AutoProvisionFiberScheduler } from './AutoProvisionFiberScheduler';

// Lookup del contrato (cliente + plan + ids GR) — espejo de prismaFiberContractLookup
// de app.ts: UN findUnique con JOIN al Client, no N+1.
async function fiberContractLookup(id: string): Promise<FiberContractSnapshot | null> {
  const row = await prisma.contract.findUnique({
    where: { id },
    select: {
      id: true,
      plan: true,
      grContratoId: true,
      client: { select: { id: true, name: true, grClienteId: true } },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    plan: row.plan,
    grContratoId: row.grContratoId ?? null,
    clientId: row.client.id,
    clientName: row.client.name,
    grClienteId: row.client.grClienteId ?? null,
  };
}

// Writer del bloque auditable — espejo de prismaFiberInstallTaskWriter de app.ts:
// la ÚLTIMA tarea no archivada del contrato recibe el bloque "── Aprovisionamiento ONU ──".
const fiberInstallTaskWriter: FiberInstallTaskWriter = {
  async findLatestByContract(contractId: string) {
    const row = await prisma.scheduledTask.findFirst({
      where: { contractId, archivedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, description: true },
    });
    return row ? { id: row.id, description: row.description ?? null } : null;
  },
  // K3 fix wave M4 — el watcher pasa auditTaskId (la tarea MATCHEADA por serial):
  // el bloque auditable aterriza AHÍ, no en la última tarea del contrato.
  async findById(taskId: string) {
    const row = await prisma.scheduledTask.findUnique({
      where: { id: taskId },
      select: { id: true, description: true },
    });
    return row ? { id: row.id, description: row.description ?? null } : null;
  },
  async updateDescription(taskId: string, description: string) {
    await prisma.scheduledTask.update({ where: { id: taskId }, data: { description } });
  },
};

/**
 * @param intervalMs - Intervalo de tick. Default: `config.fiberAutoProvision.intervalMs`
 *   (5min por default, env-configurable via FIBER_AUTO_PROVISION_INTERVAL_MS,
 *   piso 60s / techo 24h). main.ts lo invoca sin args, así que toma el valor de config.
 * @returns Scheduler listo para .start(), o null si SmartOLT no está configurado.
 */
export async function bootstrapAutoProvisionFiber(
  intervalMs = config.fiberAutoProvision.intervalMs,
): Promise<AutoProvisionFiberScheduler | null> {
  const { baseUrl, token } = config.smartolt;

  if (!baseUrl || !token) {
    // Skip SILENCIOSO (decisión K3): sin envs SmartOLT el watcher no existe.
    console.warn('[fiber-auto-watcher] SMARTOLT_BASE_URL/SMARTOLT_API_TOKEN missing -- watcher disabled');
    return null;
  }

  const gateway = new SmartOltHttpGateway({
    baseUrl,
    token,
    timeoutMs: config.smartolt.timeoutMs,
    stepPauseMs: config.smartolt.stepPauseMs,
  });

  // Cadena K1 (PPPoE) — misma composición que el bloque /api/fiber de app.ts.
  const pppoeRepo = new PrismaPppoeServiceRepository();
  const nasRepo = new PrismaNasRepository();
  const routerGw = new RouterOsGateway();
  const orchestrator = new HttpRadiusOrchestratorGateway({
    baseUrl: config.orchestrator.baseUrl,
    token: config.orchestrator.token,
    timeoutMs: config.orchestrator.timeoutMs,
  });
  const findFreeIp = new FindFreeIp(new PrismaIpNetworkRepository(), nasRepo, routerGw, orchestrator);
  const createPppoeSvc = new CreatePppoeService(
    pppoeRepo,
    routerGw,
    nasRepo,
    orchestrator,
    new EnsureInternetContractService(
      new PrismaContractServiceRepository(),
      new PrismaServiceCatalogRepository(),
      new PrismaContractServiceEventRepository(),
    ),
    new PrismaServiceCatalogRepository(),
    new PrismaContractServiceEventRepository(),
    findFreeIp,
  );
  // GR client best-effort para el username PPPoE histórico (mismo rol que en app.ts):
  // sin credenciales GR falla AL USARSE y PregenInstallPppoe cae al username generado.
  const grClient = new GestionRealClient({
    baseUrl: config.gestionReal.baseUrl,
    cuit: config.gestionReal.cuit,
    secret: config.gestionReal.secret,
  });
  const pregen = new PregenInstallPppoe(pppoeRepo, createPppoeSvc, grClient);

  const provisionFiberOnu = new ProvisionFiberOnu(
    gateway,
    new PrismaSmartOltOltConfigRepository(),
    { findById: (id: string) => fiberContractLookup(id) },
    pppoeRepo,
    pregen,
    new PrismaGestionRealIngestConfigRepository(),
    fiberInstallTaskWriter,
  );

  const watcher = new AutoProvisionFiberOnus(
    new PrismaFiberAutoProvisionTaskRepository(),
    new PrismaFiberAutoProvisionAttemptRepository(),
    gateway,
    provisionFiberOnu,
    {
      // Backoff = 2 ticks: no reintentar en el mismo tick ni el siguiente.
      retryBackoffMs: intervalMs * 2,
    },
  );

  return new AutoProvisionFiberScheduler(
    watcher,
    { intervalMs },
    new PgAdvisoryLock(),
    new PrismaFeatureFlagRepository(),
  );
}
