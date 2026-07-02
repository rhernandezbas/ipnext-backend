import {
  PppoeNasMoveEventRepository,
  PppoeNasMoveOutcome,
} from '@domain/ports/PppoeNasMoveEventRepository';

/**
 * Throttle anti-spam del registro visible de movimientos de NAS (pppoe-move-nas W2,
 * design D-W2.2 / spec S10.5 — endurecido en D-W2.5 item 7, W5/W6/S9).
 *
 * Un mismatch NO-accionable (IP pública, pool destino lleno, NAS fantasma, sesión stale,
 * conflicto multi-NAS) PERSISTE tick tras tick del watcher → sin throttle, el tab "Movimientos
 * NAS" recibiría una fila cada 2 minutos PARA SIEMPRE. Regla: un evento `skipped_*`/`failed_*`
 * con trigger 'auto' IDÉNTICO al último evento del username con menos de 6 horas NO genera fila
 * nueva. El intento/skip igual OCURRE cada tick (el move con pool lleno se reintenta, barato) —
 * solo se throttlea el REGISTRO. Los `moved` SIEMPRE se registran (cambian estado) y los intentos
 * manuales SIEMPRE se registran (el caller debe gatear por trigger === 'auto' && outcome !== 'moved').
 *
 * Throttle v2 (D-W2.5 item 7):
 *   - W5: username por igualdad EXACTA vía el filtro aditivo `usernameExact` del repo — el
 *     contains del filtro `username` hacía que 'perez1' viera la fila de 'perez10' (más nueva)
 *     y el guard de igualdad forzaba fail-open → fila duplicada CADA tick (throttle roto).
 *   - W6: suprime SOLO si el último evento es trigger 'auto' — un evento MANUAL idéntico no
 *     silencia al watcher (el operador registró lo suyo; el estado automático sigue visible).
 *   - S9: "idéntico" = mismo outcome + mismo toNasId + mismo reason (antes un cambio de reason
 *     — p.ej. unclassified_ip → public_pool al cargar el pool — quedaba invisible).
 *   - S9: si el CHECK lanza (DB hiccup) → FAIL-OPEN: se registra la fila igual (una fila de
 *     más es mejor que una supresión silenciosa). El catch vive ACÁ para cubrir a los DOS
 *     puntos de registro.
 *
 * Comparte la implementación entre los DOS puntos de registro: los `skipped_*` que registra el
 * watcher (AutoMovePppoe) y los `failed_*` que registra el core (MovePppoeToNas.recordMoveEvent).
 */
export const AUTO_MOVE_EVENT_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6 horas

export async function isDuplicateAutoEvent(
  repo: PppoeNasMoveEventRepository,
  username: string,
  outcome: PppoeNasMoveOutcome,
  toNasId: string | null,
  reason: string | null,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const { items } = await repo.list({ page: 1, limit: 1, usernameExact: username });
    const last = items[0];
    if (!last) return false;
    if (last.trigger !== 'auto') return false; // W6: un evento MANUAL nunca suprime al watcher
    if (last.outcome !== outcome) return false;
    if ((last.toNasId ?? null) !== (toNasId ?? null)) return false;
    if ((last.reason ?? null) !== (reason ?? null)) return false; // S9: reason es parte de la identidad
    const age = nowMs - Date.parse(last.createdAt);
    return Number.isFinite(age) && age < AUTO_MOVE_EVENT_THROTTLE_MS;
  } catch (err) {
    // S9: FAIL-OPEN — el registro visible no puede depender de que el check funcione.
    console.warn('[pppoeNasMoveThrottle] check del throttle falló — FAIL-OPEN (la fila se registra igual):', err);
    return false;
  }
}
