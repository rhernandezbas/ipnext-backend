/**
 * bootstrapSnoozeReactivation — composition root del watcher que reactiva las conversaciones
 * snoozed vencidas (conversation-snooze Ola 6c, opción a).
 *
 * A diferencia de bootstrapRadiusAutoCure, NO depende de ningún gateway externo (opera sólo
 * sobre el mirror local), así que SIEMPRE retorna un scheduler listo para `.start()`.
 *
 * ON/OFF: feature flag 'snooze-reactivation' (seed OFF por migración 20260928000000), chequeado
 * POR TICK dentro del scheduler — prender/apagar NO requiere restart. Dark by default: las
 * vistas/counts ya son correctos sin el watcher (derivación lazy); esto sólo normaliza el status.
 */
import { PrismaConversationRepository } from '../adapters/prisma/PrismaConversationRepository';
import { PrismaConversationEventRepository } from '../adapters/prisma/PrismaConversationEventRepository';
import { PrismaFeatureFlagRepository } from '../adapters/prisma/PrismaFeatureFlagRepository';
import { PgAdvisoryLock } from '../adapters/pg/PgAdvisoryLock';
import { ReactivateExpiredSnoozes } from '@application/use-cases/messaging/ReactivateExpiredSnoozes';
import { SnoozeReactivationScheduler } from './SnoozeReactivationScheduler';

/**
 * @param intervalMs - Intervalo de tick. Default 60s (la reaparición lazy ya cubre las vistas al
 *   instante; el watcher es sólo higiene de status en DB, no necesita ser agresivo).
 */
export async function bootstrapSnoozeReactivation(intervalMs = 60_000): Promise<SnoozeReactivationScheduler> {
  const conversationRepo = new PrismaConversationRepository();
  const eventRepo = new PrismaConversationEventRepository();
  const reactivate = new ReactivateExpiredSnoozes(conversationRepo, eventRepo);
  return new SnoozeReactivationScheduler(reactivate, { intervalMs }, new PgAdvisoryLock(), new PrismaFeatureFlagRepository());
}
