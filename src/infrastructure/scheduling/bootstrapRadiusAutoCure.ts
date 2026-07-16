/**
 * bootstrapRadiusAutoCure — composition root del watcher de auto-curación de sesiones RADIUS
 * colgadas (radius-session-autocure BE-1, REQ-CURE-7).
 *
 * Espejo de bootstrapPppoeAutoMove: retorna null cuando ORCHESTRATOR_BASE_URL no está
 * configurado (opt-in) — sin orchestrator no hay sesiones que curar. El tuning del watcher
 * (lookback/breaker/cap/cooldown/flapping + los gates del core) baja de `config.radiusAutoCure`
 * — S7.2, sin esta inyección las envs RADIUS_AUTO_CURE_* quedarían muertas.
 *
 * ON/OFF: feature flag 'radius-auto-cure' (seed OFF por migración), chequeado POR TICK dentro
 * del scheduler — NO acá (prender/apagar no requiere restart).
 */
import { config } from '../config';
import { HttpRadiusOrchestratorGateway } from '../adapters/orchestrator/HttpRadiusOrchestratorGateway';
import { PrismaRadiusAuthEventRepository } from '../adapters/prisma/PrismaRadiusAuthEventRepository';
import { PrismaRadiusSessionCureEventRepository } from '../adapters/prisma/PrismaRadiusSessionCureEventRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { CureStuckSession } from '@application/use-cases/CureStuckSession';
import { AutoCureStuckSessions } from '@application/use-cases/AutoCureStuckSessions';
import { RadiusAutoCureScheduler } from './RadiusAutoCureScheduler';

/**
 * @param intervalMs - Intervalo de tick. Default: `config.radiusAutoCure.intervalMs`
 *   (60s por default, env-configurable via RADIUS_AUTO_CURE_INTERVAL_MS, piso 15s / techo 24h).
 *   main.ts lo invoca sin args, así que toma el valor de config.
 * @returns Scheduler listo para .start(), o null si el orchestrator no está configurado.
 */
export async function bootstrapRadiusAutoCure(
  intervalMs = config.radiusAutoCure.intervalMs,
): Promise<RadiusAutoCureScheduler | null> {
  const { baseUrl, token } = config.orchestrator;

  if (!baseUrl) {
    console.warn('[radius-auto-cure] ORCHESTRATOR_BASE_URL missing -- scheduler disabled');
    return null;
  }

  const gateway = new HttpRadiusOrchestratorGateway({ baseUrl, token, timeoutMs: config.orchestrator.timeoutMs });
  const radiusAuthEventRepo = new PrismaRadiusAuthEventRepository();
  const cureEventRepo = new PrismaRadiusSessionCureEventRepository();

  const cureStuckSession = new CureStuckSession(gateway, cureEventRepo, {
    staleMs: config.radiusAutoCure.staleMs,
    persistenceMs: config.radiusAutoCure.persistenceMs,
    recencyMs: config.radiusAutoCure.recencyMs,
  });

  const autoCure = new AutoCureStuckSessions(radiusAuthEventRepo, cureEventRepo, cureStuckSession, {
    lookbackMs: config.radiusAutoCure.lookbackMs,
    abortThreshold: config.radiusAutoCure.abortThreshold,
    maxPerTick: config.radiusAutoCure.maxPerTick,
    cooldownMs: config.radiusAutoCure.cooldownMs,
    flappingMax: config.radiusAutoCure.flappingMax,
  });

  return new RadiusAutoCureScheduler(autoCure, { intervalMs }, new PgAdvisoryLock(), new PrismaFeatureFlagRepository());
}
