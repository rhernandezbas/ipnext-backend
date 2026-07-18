import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { TaskNotFoundError } from '@domain/errors/scheduling';
import { TaskNotBroadcastableError } from '@domain/errors/nocBroadcast';
import { BroadcastToNoc, BroadcastToNocResult } from './BroadcastToNoc';

/**
 * N3 (network-task-broadcast) — "Send to WS" de una tarea de RED al canal NOC.
 *
 * Orquesta el N1 (BroadcastToNoc) para una tarea puntual:
 *   1. Resuelve la tarea por id (404 TaskNotFoundError si no existe).
 *   2. Sólo tareas de RED se difunden (422 TaskNotBroadcastableError si kind!='network').
 *   3. contextLabel = nombre del nodo. `networkSiteName` ya viene resuelto por el
 *      read-path (JOIN a NetworkSite.name para 'red', columna almacenada para 'fibra').
 *      null → se pasa `undefined` y el motor arma "[Red]" sin etiqueta.
 *   4. relativePath = /admin/scheduling/tasks/{id} (deep link a la page de detalle).
 *
 * NOT best-effort: es disparado por un botón, así que los errores del motor
 * (NOC_BROADCAST_NOT_CONFIGURED 503, EVOLUTION_API_ERROR 502, LINK_BASE_MISSING 422)
 * PROPAGAN sin envolverse — el front muestra el fallo.
 */
export class BroadcastTaskToNoc {
  constructor(
    private readonly scheduling: SchedulingRepository,
    private readonly broadcast: BroadcastToNoc,
  ) {}

  async execute(taskId: string): Promise<BroadcastToNocResult> {
    const task = await this.scheduling.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.kind !== 'network') throw new TaskNotBroadcastableError();

    return this.broadcast.execute({
      kind: 'network_task',
      title: task.title,
      // null → undefined: el motor trata etiqueta ausente/blanca como "[Red]".
      contextLabel: task.networkSiteName ?? undefined,
      relativePath: `/admin/scheduling/tasks/${taskId}`,
    });
  }
}
