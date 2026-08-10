import { SchedulingRepository, ClosureStamp } from '@domain/ports/SchedulingRepository';
import { TaskGeneralStatus } from '@domain/entities/scheduling';

/**
 * FIX-C (fix wave 2 W1a) — el REOPEN preserva el sello de cierre en la activity.
 *
 * FIX-1 hace lo correcto al limpiar las cuatro columnas de cierre en toda transición a
 * un `generalStatus` distinto de `'closed'`. El efecto colateral es que "quién cerró
 * esto, cuándo y con qué resultado" DESAPARECE del sistema justo en el evento más
 * auditable: cuando alguien deshace un cierre. El `status_changed` que ya se emite en
 * ese momento es el lugar natural del sello — `ScheduledTaskActivity` es append-only,
 * así que lo que se guarda ahí no lo pisa ningún reopen posterior.
 *
 * Vive acá, compartido, porque hay DOS escritores de reopen (`SetTaskGeneralStatus` y
 * `UpdateTask`, éste último por dos vías: `generalStatus` y el legacy `isClosed:false`)
 * y el defecto era de CLASE: arreglarlo en uno dejaba al hermano igual de mudo.
 */

/**
 * Clave bajo la que viaja el sello en `metadata` del `status_changed`. Es un `type` y
 * no una `interface` a propósito: el puerto del recorder pide `Record<string, unknown>`
 * y TypeScript sólo le da index signature implícita a los alias de tipo.
 */
export type ClearedClosureMetadata = Record<string, unknown> & {
  clearedClosure: ClosureStamp;
};

/**
 * `gs` efectivo de un patch: `generalStatus` gana sobre el legacy `isClosed`
 * (precedencia D4, la misma que aplican los dos adapters al traducir el update).
 * `undefined` = el patch no toca el estado.
 */
export function effectiveGeneralStatus(
  generalStatus?: TaskGeneralStatus,
  isClosed?: boolean,
): TaskGeneralStatus | undefined {
  if (generalStatus !== undefined) return generalStatus;
  if (isClosed !== undefined) return isClosed ? 'closed' : 'open';
  return undefined;
}

/** ¿Esta transición es un REOPEN (de cerrada a cualquier otra cosa)? */
export function isReopen(
  previous: TaskGeneralStatus,
  next: TaskGeneralStatus | undefined,
): boolean {
  return previous === 'closed' && next !== undefined && next !== 'closed';
}

/**
 * Lee el sello ANTES de que la escritura lo borre. Devuelve null cuando no hay nada que
 * preservar (no es un reopen, la tarea no existe, o es una fila legacy sin sello) — el
 * caller NO debe emitir `metadata` en ese caso: un objeto con cuatro nulls diría
 * "cerrada por nadie" cuando la verdad es "no hay dato".
 */
export async function readClearedClosureStamp(
  repo: SchedulingRepository,
  taskId: string,
  previous: TaskGeneralStatus,
  next: TaskGeneralStatus | undefined,
): Promise<ClosureStamp | null> {
  if (!isReopen(previous, next)) return null;
  return repo.getClosureStamp(taskId);
}

/** `{ clearedClosure }` listo para spread, o `undefined` cuando no hay sello. */
export function clearedClosureMetadata(
  stamp: ClosureStamp | null,
): ClearedClosureMetadata | undefined {
  return stamp ? { clearedClosure: stamp } : undefined;
}
