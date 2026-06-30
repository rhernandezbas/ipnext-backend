/**
 * parseIntervalMs — parsea un intervalo (en ms) desde una env var OPCIONAL, con
 * default, mínimo y máximo de seguridad. Pura y testeable: NO toca process.env ni lanza.
 *
 * Sigue el patrón robusto que ya usa `config.ts` para `minio.port` (Number(...) +
 * validación, en vez de `parseInt` que aceptaría basura como '120000abc').
 *
 * Reglas:
 * - ausente / '' / no-numérico / NaN / <= 0  → max(`opts.default`, `opts.min`)
 * - valor válido por debajo de `opts.min`    → `opts.min` (clamp al piso de seguridad)
 * - valor válido por encima de `opts.max`    → `opts.max` (clamp al techo)
 * - valor válido en rango                    → el valor (truncado a entero)
 *
 * El clamp-al-mínimo (en vez de caer al default) honra la intención "más fresco"
 * sin permitir martillar al consumidor por debajo del piso seguro. El TECHO evita el
 * footgun de Node: un delay > TIMEOUT_MAX (~24.8 días) hace que setInterval dispare
 * cada 1ms (un fat-finger por confusión de unidades martillaría al consumidor). El
 * default se clampea contra el min por las dudas (invariante defendida, no asumida).
 * Nunca crashea: pensada para schedulers opt-in que NO deben tumbar el boot.
 */
export function parseIntervalMs(
  raw: string | undefined,
  opts: { default: number; min: number; max?: number },
): number {
  // TIMEOUT_MAX de Node (2^31 - 1 ms ≈ 24.8 días): delays mayores se coaccionan a 1ms.
  const max = opts.max ?? 2_147_483_647;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Math.max(opts.default, opts.min);
  return Math.floor(Math.min(Math.max(n, opts.min), max));
}
