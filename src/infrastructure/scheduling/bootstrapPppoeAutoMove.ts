/**
 * bootstrapPppoeAutoMove — composition root del watcher auto-move de PPPoE (pppoe-move-nas W2).
 *
 * Espejo de bootstrapRadiusAuthIngest. Retorna null cuando ORCHESTRATOR_BASE_URL no está
 * configurado (opt-in): sin orchestrator no hay sesiones que mirar ni RADIUS que escribir.
 *
 * El watcher REUSA el core MovePppoeToNas de W1 (radius-aware, con su registro doble
 * moved/failed_* + historial 'sistema') — acá solo se cablea la MISMA composición que app.ts
 * usa para la ruta manual, con adapters Prisma frescos (instancias separadas del request-path,
 * mismo modelo de datos).
 *
 * ON/OFF: feature flag 'pppoe-auto-move' (seed OFF por migración), chequeado POR TICK dentro
 * del scheduler — NO acá (prender/apagar no requiere restart).
 */
import { config } from '../config';
import { HttpRadiusOrchestratorGateway } from '../adapters/orchestrator/HttpRadiusOrchestratorGateway';
import { RouterOsGateway } from '../adapters/routeros/RouterOsGateway';
import { PrismaPppoeServiceRepository } from '../adapters/prisma/PrismaPppoeServiceRepository';
import { PrismaNasRepository } from '../adapters/prisma/PrismaNasRepository';
import { PrismaIpNetworkRepository } from '../adapters/prisma/PrismaIpNetworkRepository';
import { PrismaPppoeNasMoveEventRepository } from '../adapters/prisma/PrismaPppoeNasMoveEventRepository';
import { PrismaServiceCatalogRepository } from '../adapters/prisma/PrismaServiceCatalogRepository';
import { PrismaContractServiceEventRepository } from '../adapters/prisma/PrismaContractServiceEventRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { MovePppoeToNas } from '@application/use-cases/MovePppoeToNas';
import { AutoMovePppoe } from '@application/use-cases/AutoMovePppoe';
import { PppoeAutoMoveScheduler } from './PppoeAutoMoveScheduler';

/**
 * @param intervalMs - Intervalo de tick. Default: `config.pppoeAutoMove.intervalMs`
 *   (120s por default, env-configurable via AUTO_MOVE_INTERVAL_MS, piso 15s / techo 24h).
 *   main.ts lo invoca sin args, así que toma el valor de config.
 * @returns Scheduler listo para .start(), o null si el orchestrator no está configurado.
 */
export async function bootstrapPppoeAutoMove(
  intervalMs = config.pppoeAutoMove.intervalMs,
): Promise<PppoeAutoMoveScheduler | null> {
  const { baseUrl, token } = config.orchestrator;

  if (!baseUrl) {
    console.warn('[pppoe-auto-move] ORCHESTRATOR_BASE_URL missing -- scheduler disabled');
    return null;
  }

  const gateway       = new HttpRadiusOrchestratorGateway({ baseUrl, token, timeoutMs: config.orchestrator.timeoutMs });
  const pppoeRepo     = new PrismaPppoeServiceRepository();
  const nasRepo       = new PrismaNasRepository();
  const ipNetworkRepo = new PrismaIpNetworkRepository();
  const moveEventRepo = new PrismaPppoeNasMoveEventRepository();
  const routerGw      = new RouterOsGateway();

  // MISMA composición del move radius-aware que la ruta manual en app.ts (pppoe-move-nas W1).
  const findFreeIp = new FindFreeIp(ipNetworkRepo, nasRepo, routerGw, gateway);
  const legacyMove = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo);
  const movePppoeToNas = new MovePppoeToNas(
    pppoeRepo,
    nasRepo,
    gateway,
    findFreeIp,
    legacyMove,
    moveEventRepo,
    new PrismaServiceCatalogRepository(),
    new PrismaContractServiceEventRepository(),
    ipNetworkRepo,
  );

  const autoMove = new AutoMovePppoe(gateway, nasRepo, pppoeRepo, ipNetworkRepo, moveEventRepo, movePppoeToNas);

  return new PppoeAutoMoveScheduler(autoMove, { intervalMs }, new PgAdvisoryLock(), new PrismaFeatureFlagRepository());
}
