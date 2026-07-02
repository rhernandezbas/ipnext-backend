import {
  PppoeNasMoveEventRepository,
  PppoeNasMoveOutcome,
} from '@domain/ports/PppoeNasMoveEventRepository';

/**
 * Throttle anti-spam del registro visible de movimientos de NAS (pppoe-move-nas W2,
 * design D-W2.2 / spec S10.5).
 *
 * Un mismatch NO-accionable (IP pública, pool destino lleno, NAS fantasma) PERSISTE tick tras
 * tick del watcher → sin throttle, el tab "Movimientos NAS" recibiría una fila cada 2 minutos
 * PARA SIEMPRE. Regla: un evento `skipped_*`/`failed_*` con trigger 'auto' IDÉNTICO al último
 * evento del username (mismo outcome + mismo toNasId) con menos de 6 horas NO genera fila nueva.
 * El intento/skip igual OCURRE cada tick (el move con pool lleno se reintenta, barato) — solo se
 * throttlea el REGISTRO. Los `moved` SIEMPRE se registran (cambian estado) y los intentos
 * manuales SIEMPRE se registran (el caller debe gatear por trigger === 'auto' && outcome !== 'moved').
 *
 * Comparte la implementación entre los DOS puntos de registro: los `skipped_*` que registra el
 * watcher (AutoMovePppoe) y los `failed_*` que registra el core (MovePppoeToNas.recordMoveEvent).
 *
 * Gotcha del repo: el filtro `username` de `list()` es coincidencia PARCIAL case-insensitive
 * (hábito del repo para búsquedas). El último evento devuelto podría ser de OTRO username que
 * contiene al buscado (p.ej. 'perez10' al consultar 'perez1') → se exige match EXACTO del
 * username: si no coincide, se registra igual (FAIL-OPEN: una fila de más es mejor que una
 * fila suprimida por error).
 */
export const AUTO_MOVE_EVENT_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6 horas

export async function isDuplicateAutoEvent(
  repo: PppoeNasMoveEventRepository,
  username: string,
  outcome: PppoeNasMoveOutcome,
  toNasId: string | null,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const { items } = await repo.list({ page: 1, limit: 1, username });
  const last = items[0];
  if (!last) return false;
  if (last.username !== username) return false; // match parcial del repo → exigir exacto (fail-open)
  if (last.outcome !== outcome) return false;
  if ((last.toNasId ?? null) !== (toNasId ?? null)) return false;
  const age = nowMs - Date.parse(last.createdAt);
  return Number.isFinite(age) && age < AUTO_MOVE_EVENT_THROTTLE_MS;
}
