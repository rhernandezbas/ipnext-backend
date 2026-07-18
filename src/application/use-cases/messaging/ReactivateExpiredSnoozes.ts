import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ConversationEventRepository } from '@domain/ports/ConversationEventRepository';

export interface ReactivateExpiredSnoozesSummary {
  /** Conversaciones snoozed cuyo snoozedUntil venció (candidatas de este tick). */
  candidates: number;
  /** Reactivadas OK (status → 'open', snoozedUntil → null). */
  reactivated: number;
  /** Fallaron al reactivar el status (el upsert lanzó). El evento es best-effort, NO cuenta acá. */
  failed: number;
}

/**
 * ReactivateExpiredSnoozes (conversation-snooze Ola 6c, watcher opción a — NÚCLEO) — normaliza
 * en DB las conversaciones snoozed cuyo `snoozedUntil` YA venció: `status='open'`,
 * `snoozedUntil=null`, evento 'unsnoozed' (best-effort). Es COMPLEMENTARIO a la derivación lazy
 * de los buckets (opción b): las vistas/counts YA muestran una snoozed vencida como `open` sin
 * cron; este watcher además limpia el status en DB (higiene) y deja un evento limpio en el
 * historial (cimiento Ola 2). Corre bajo `SnoozeReactivationScheduler` (interval + lock + flag
 * dark-by-default). Molde de "buscar candidatos → procesar cada uno" de `AutoCureStuckSessions`.
 *
 * La reactivación reusa `upsertByChatwootId` (keyed por chatwootConversationId): una snoozed
 * SIEMPRE tiene chatwootConversationId (el snooze pasa por Chatwoot). Defensivo: una fila sin
 * chatwootConversationId se saltea (no debería existir snoozed sin él).
 */
export class ReactivateExpiredSnoozes {
  private static readonly MAX_PER_TICK = 200;

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly eventRepo?: ConversationEventRepository,
  ) {}

  async run(): Promise<ReactivateExpiredSnoozesSummary> {
    const nowIso = new Date().toISOString();
    const expired = await this.conversationRepo.listExpiredSnoozed(nowIso, ReactivateExpiredSnoozes.MAX_PER_TICK);

    let reactivated = 0;
    let failed = 0;

    for (const conv of expired) {
      if (conv.chatwootConversationId === null) continue; // defensivo: no upsertable
      try {
        await this.conversationRepo.upsertByChatwootId({
          chatwootConversationId: conv.chatwootConversationId,
          status: 'open',
          snoozedUntil: null,
        });
        reactivated += 1;
      } catch {
        failed += 1;
        continue;
      }

      // Evento 'unsnoozed' — best-effort (actor null: es el sistema, no un usuario RBAC).
      if (this.eventRepo) {
        try {
          await this.eventRepo.record({
            conversationId: conv.id,
            type: 'unsnoozed',
            actorId: null,
            fromValue: 'snoozed',
            toValue: 'open',
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[messaging] registro de ConversationEvent (unsnoozed) falló (best-effort, ya reactivada)', {
            conversationId: conv.id,
            error: err instanceof Error ? err.message : err,
          });
        }
      }
    }

    return { candidates: expired.length, reactivated, failed };
  }
}
