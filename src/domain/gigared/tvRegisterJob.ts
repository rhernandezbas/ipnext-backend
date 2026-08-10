import type { TvRegisterStatusRow } from '../ports/ClientTvRegisterStatusRepository';

/**
 * gigared-alta-asincrona W1.3 — WATCHDOG del job de alta.
 *
 * `CancelTvJobRunner` tiene hoy un agujero abierto: no expira los `running` huérfanos. Un proceso
 * que muere a mitad (deploy, OOM, restart) deja el estado en `running` PARA SIEMPRE y el guard
 * anti-doble-disparo bloquea al cliente hasta que alguien edite la DB a mano. Este change NO lo
 * hereda: el estado lleva timestamp y se expira.
 *
 * La regla vive acá, PURA y en un solo lugar, porque la consumen DOS call-sites (el guard 409 del
 * POST y el GET de estado). Duplicada, el test certificaría una copia mientras producción corre la
 * otra.
 */

/**
 * Cuánto puede durar un alta antes de considerarse muerta.
 *
 * Números medidos contra el partner el 2026-08-10: un alta hace hasta 17 llamadas y tardó 114 s sin
 * tráfico de fondo, 264 s con 5 req/min y 354–369 s con 3 altas concurrentes. 15 minutos deja ~2.4×
 * de margen sobre el peor caso medido, y acota a 15 minutos —no a "para siempre"— el tiempo que un
 * proceso caído puede bloquear a un cliente.
 */
export const TV_REGISTER_JOB_TTL_MS = 15 * 60 * 1000;

/**
 * ¿Hay un alta VIVA para este cliente?
 *
 * - `done` / `failed` / fila ausente → false (siempre re-encolable).
 * - `pending` / `running` con `startedAt` más viejo que el TTL → false (job huérfano, se libera).
 * - `pending` / `running` SIN `startedAt` → true. La edad es INDETERMINABLE y ahí el lado seguro es
 *   bloquear: dos altas concurrentes que ambas fallen el probe producen dos `register` reales y
 *   queman al cliente de forma PERMANENTE, mientras que bloquear de más es operativo y reversible.
 *   Nuestro código siempre escribe `startedAt` (también en `pending`), así que esta rama sólo se
 *   alcanza con basura escrita por fuera.
 */
export function isTvRegisterJobActive(
  row: TvRegisterStatusRow | null | undefined,
  now: Date,
  ttlMs: number = TV_REGISTER_JOB_TTL_MS,
): boolean {
  if (!row) return false;
  if (row.status !== 'pending' && row.status !== 'running') return false;
  if (!row.startedAt) return true;
  return now.getTime() - row.startedAt.getTime() < ttlMs;
}
