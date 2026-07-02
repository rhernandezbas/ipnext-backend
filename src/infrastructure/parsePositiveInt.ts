/**
 * parsePositiveInt — parsea un ENTERO POSITIVO desde una env var OPCIONAL (umbrales/contadores,
 * NO intervalos — para intervalos está parseIntervalMs). Pura y testeable: NO toca process.env
 * ni lanza NUNCA (pensada para tuning de schedulers opt-in que jamás deben tumbar el boot).
 *
 * Reglas (pppoe-move-nas D-W2.5 item 1 — AUTO_MOVE_ABORT_THRESHOLD / AUTO_MOVE_MAX_MOVES_PER_TICK):
 * - ausente / '' / no-numérico / NaN / <= 0 → `opts.default` (un fat-finger no puede dejar el
 *   circuit breaker en 0 = "abortar siempre" ni el cap en 0 = "no mover nunca")
 * - valor válido → floor(valor), clampeado a [min (default 1), max (default MAX_SAFE_INTEGER)]
 */
export function parsePositiveInt(
  raw: string | undefined,
  opts: { default: number; min?: number; max?: number },
): number {
  const min = opts.min ?? 1;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return opts.default;
  return Math.floor(Math.min(Math.max(n, min), max));
}
