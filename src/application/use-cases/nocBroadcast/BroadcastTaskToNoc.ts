import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { ActorContext, TaskActivityRecorder } from '@domain/ports/TaskActivityRecorder';
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
 *
 * noc-broadcast-traceability — DESPUÉS de un envío exitoso deja rastro:
 *   1. estampa lastBroadcastAt/lastBroadcastByName en la tarea (badge "Última difusión"),
 *   2. registra un evento 'noc_broadcast_sent' en el feed de Actividad (best-effort interno
 *      del recorder — nunca aborta la operación).
 * Si el envío falla (throw antes), NADA se estampa ni registra.
 */
export class BroadcastTaskToNoc {
  constructor(
    private readonly scheduling: SchedulingRepository,
    private readonly broadcast: BroadcastToNoc,
    /** Opcional: si se inyecta, emite un evento 'noc_broadcast_sent' en el feed (best-effort). */
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(taskId: string, actor: ActorContext): Promise<BroadcastToNocResult> {
    const task = await this.scheduling.getTask(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.kind !== 'network') throw new TaskNotBroadcastableError();

    const result = await this.broadcast.execute({
      kind: 'network_task',
      title: task.title,
      // null → undefined: el motor trata etiqueta ausente/blanca como "[Red]".
      contextLabel: task.networkSiteName ?? undefined,
      relativePath: `/admin/scheduling/tasks/${taskId}`,
    });

    // Solo tras un envío exitoso (arriba propaga en el path de error): dejar rastro.
    // El stamp propaga salvo P2025 (tarea borrada); el recorder es best-effort internamente.
    await this.scheduling.recordTaskBroadcast(taskId, actor.actorName);
    await this.recorder?.record(taskId, 'noc_broadcast_sent', {
      actor,
      metadata: { link: result.link },
    });

    return result;
  }
}
