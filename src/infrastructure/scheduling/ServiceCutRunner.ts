import type { RunBulkEnforcementInput } from '@application/use-cases/RunBulkEnforcement';
import type { ServiceCutBatch } from '@domain/entities/serviceCutBatch';
import type { EnforcementAction } from '@domain/entities/pppoeService';
import type { ServiceCutBatchRepository } from '@domain/ports/ServiceCutBatchRepository';
import type { DistributedLock } from '@domain/ports/DistributedLock';

/** Estructural: cualquier ejecutor de bulk (RunBulkEnforcement lo satisface). */
export interface BulkEnforcer {
  execute(input: RunBulkEnforcementInput): Promise<ServiceCutBatch>;
}

/** Clave del lock distribuido: un solo batch de corte a la vez en todo el cluster. */
export const SERVICE_CUT_LOCK_KEY = 'pppoe-enforcement-bulk';

/**
 * ServiceCutRunner (Fase C) — shell fire-and-forget para los cortes MASIVOS on-demand.
 * Molde de `CancelTvJobRunner` + `PgAdvisoryLock`. **NO hay scheduler/cron**: el operador
 * dispara cada batch con un POST; el runner garantiza un único batch simultáneo (lock distribuido).
 *
 * `start()` es rápido (lock + crear el batch) y devuelve el `batchId` para pollear. El trabajo
 * pesado corre en background (`done`), liberando el lock al terminar. La ruta hace
 * `void runner.start(...)`-style: usa `accepted`/`batchId` y NO espera `done` (los tests sí).
 */
export class ServiceCutRunner {
  constructor(
    private readonly bulk: BulkEnforcer,
    private readonly batchRepo: ServiceCutBatchRepository,
    private readonly lock: DistributedLock,
  ) {}

  /**
   * Intenta arrancar un batch. Si ya hay uno corriendo (lock tomado) → { accepted:false }.
   * Si arranca → crea el batch 'pending', dispara el trabajo en background y devuelve su id.
   */
  async start(
    action: EnforcementAction,
    pppoeIds: string[],
  ): Promise<{ accepted: boolean; batchId?: string; done?: Promise<void> }> {
    const acquired = await this.lock.tryAcquire(SERVICE_CUT_LOCK_KEY);
    if (!acquired) return { accepted: false };

    let batch: ServiceCutBatch;
    try {
      batch = await this.batchRepo.create({ action, total: pppoeIds.length });
    } catch (err) {
      await this.lock.release(SERVICE_CUT_LOCK_KEY);
      throw err;
    }

    const done = this.run(batch.id, action, pppoeIds).finally(async () => {
      try {
        await this.lock.release(SERVICE_CUT_LOCK_KEY);
      } catch (err) {
        // Defensivo: un fallo al liberar el lock se LOGUEA (no se traga en silencio).
        // eslint-disable-next-line no-console
        console.error('[ServiceCutRunner] lock release failed:', err instanceof Error ? err.message : err);
      }
    });
    // Fire-and-forget: no propagar rechazos al caller (run nunca tira, pero por las dudas).
    void done.catch(() => {});
    return { accepted: true, batchId: batch.id, done };
  }

  private async run(batchId: string, action: EnforcementAction, pppoeIds: string[]): Promise<void> {
    try {
      await this.bulk.execute({ batchId, action, pppoeIds });
    } catch (err) {
      // Fallo catastrófico (el bulk ya es best-effort por item; esto cubre fallos del propio job).
      // eslint-disable-next-line no-console
      console.error('[ServiceCutRunner] bulk failed:', err instanceof Error ? err.message : err);
      await this.batchRepo.update(batchId, { status: 'failed', finishedAt: new Date().toISOString() });
    }
  }
}
