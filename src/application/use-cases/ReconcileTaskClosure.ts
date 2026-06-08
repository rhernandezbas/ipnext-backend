import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import { BackfillClosedServiceOrders } from './BackfillClosedServiceOrders';
import { IngestClosedCounts, emptyClosedCounts } from './IngestClosedServiceOrders';

/**
 * Reconcilia el cierre de UNA tarea de forma síncrona (200, sin scheduler ni 202).
 * Resuelve la tarea por id; si no existe lanza `TaskNotFoundError` (→ 404 vía el
 * handler global). Reutiliza `BackfillClosedServiceOrders.reconcileOne` para correr
 * exactamente la misma lógica que el batch (consulta IClass por serviceOrderCode +
 * processSummary). La ventana [begin, now] proviene del backfill (fuente de verdad).
 */
export class ReconcileTaskClosure {
  constructor(
    private readonly scheduling: SchedulingRepository,
    private readonly backfill: BackfillClosedServiceOrders,
  ) {}

  async execute(taskId: string): Promise<IngestClosedCounts> {
    const task = await this.scheduling.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    const counts = emptyClosedCounts();
    const { begin, now } = this.backfill.computeWindow();
    await this.backfill.reconcileOne(task, begin, now, counts);
    return counts;
  }
}
