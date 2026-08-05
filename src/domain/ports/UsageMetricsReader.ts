/**
 * portal-usage-metrics — lectura AGREGADA del consumo de un usuario PPPoE, para
 * la sección "Mi consumo" de Mis servicios.
 *
 * La fuente es `RadiusEvent` (el accounting de RADIUS que ingesta el BE). El
 * puerto devuelve el consumo YA AGRUPADO POR DÍA porque la agregación tiene que
 * pasar en la base: la tabla tiene ~105k filas y crece, y traer las sesiones
 * crudas a Node para sumarlas en un `reduce` es exactamente el patrón que no
 * escala. El adapter Prisma lo resuelve en UNA sola query.
 *
 * ── DOS REGLAS DURAS DEL DATO (medidas contra la población real de prod) ──────
 *
 * 1. `bytesOut` = DESCARGA del cliente · `bytesIn` = SUBIDA. El accounting está
 *    escrito desde el punto de vista del NAS: lo que "sale" del NAS es lo que
 *    BAJA el cliente. Medido: 41.572 sesiones con bytesOut>bytesIn contra 2.220
 *    al revés, y 1.671 TB out contra 169 TB in (10:1). Invertirlo le muestra al
 *    cliente que subió 10 veces lo que bajó.
 *
 * 2. Los contadores son ACUMULADOS POR SESIÓN, NO deltas: cada evento
 *    (`start`/`interim`/`stop`) trae el total de ESA sesión hasta ese momento.
 *    Sumar todos los eventos MULTIPLICA el consumo. TODA implementación de este
 *    puerto DEBE quedarse con UN solo evento por `sourceUniqueId` (el más
 *    reciente) antes de sumar. `sourceUniqueId` ES la sesión — es la clave de
 *    idempotencia del ingest.
 *
 * El bucketing por día se hace en hora LOCAL de Argentina
 * (`America/Argentina/Buenos_Aires`, UTC-3 fijo — sin DST desde 2009), para que
 * una sesión de las 22:00 caiga en su día y no "mañana UTC". El FILTRO por rango
 * `[from, to)` opera sobre el instante crudo. Misma decisión y misma forma que
 * `ConversationEventRepository` / `ChatMessageRepository`.
 *
 * El anclaje por `username` es DEL PUERTO, no del caller: la implementación DEBE
 * filtrar por username en su propio WHERE.
 */

/** Consumo de UN día (fecha local de Argentina) para un username. */
export interface UsageDailyBucket {
  /** `YYYY-MM-DD` en zona `America/Argentina/Buenos_Aires`. */
  date: string;
  /** SUMA de `bytesOut` de las sesiones del día. `bigint`: el accounting es BigInt en la DB. */
  downloadBytes: bigint;
  /** SUMA de `bytesIn` de las sesiones del día. */
  uploadBytes: bigint;
}

export interface UsageDailyUsageQuery {
  /** Login PPPoE = `RadiusEvent.username`. */
  username: string;
  /** Instante UTC inclusive. */
  from: Date;
  /** Instante UTC EXCLUSIVO. */
  to: Date;
}

export interface UsageMetricsReader {
  /**
   * Consumo diario del username en `[from, to)`. UNA sola query agregada.
   *
   * SOLO devuelve los días CON tráfico — el relleno del calendario (los días en
   * cero) es del use case, que es el que conoce el período que se le muestra al
   * cliente. Orden ascendente por fecha.
   */
  dailyUsageByUsername(query: UsageDailyUsageQuery): Promise<UsageDailyBucket[]>;
}
