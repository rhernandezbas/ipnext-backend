/**
 * portal-usage-metrics — lectura de las SESIONES de consumo de los usernames
 * PPPoE de un contrato, para la sección "Mi consumo" de Mis servicios.
 *
 * La fuente es `RadiusEvent` (el accounting de RADIUS que ingesta el BE). El
 * puerto devuelve las sesiones SOLAPANTES CRUDAS — no un agregado por día — y la
 * estimación (prorrateo por fracción temporal + reparto uniforme por día) vive
 * en UNA sola función pura de application (`prorateUsageSessions`), compartida
 * por el camino de prod y el gemelo in-memory. Razones, en orden:
 *
 *  1. C1: el ingest upsertea UNA fila por sesión con `startedAt` FIJO y
 *     contadores acumulados creciendo in-place. La ventana tiene que ser POR
 *     SOLAPAMIENTO (`startedAt < to AND (stoppedAt IS NULL OR stoppedAt >=
 *     from)`) — con el filtro viejo `startedAt >= from`, la sesión always-on
 *     nacida el mes anterior (población mayoritaria en fibra) desaparecía del
 *     mes en curso y el cliente veía 0 bytes. Una sesión que CRUZA el borde del
 *     mes no puede atribuirse entera a ningún día: hay que prorratear, y esa
 *     aritmética en SQL (fracciones + generate_series por día) es ilegible y
 *     habría que DUPLICARLA en el gemelo.
 *  2. El costo de traer crudo es acotado POR CONSTRUCCIÓN: el WHERE ancla por
 *     username(s) del contrato y por solapamiento con UN mes → 3-30 filas por
 *     username/mes (una por sesión, no por evento), no la tabla de ~105k.
 *
 * ── DOS REGLAS DURAS DEL DATO (medidas contra la población real de prod) ──────
 *
 * 1. `bytesOut` = DESCARGA del cliente · `bytesIn` = SUBIDA. El accounting está
 *    escrito desde el punto de vista del NAS: lo que "sale" del NAS es lo que
 *    BAJA el cliente. Medido: 41.572 sesiones con bytesOut>bytesIn contra 2.220
 *    al revés, y 1.671 TB out contra 169 TB in (10:1). Invertirlo le muestra al
 *    cliente que subió 10 veces lo que bajó. El mapeo a
 *    `downloadBytes`/`uploadBytes` es responsabilidad DEL PUERTO.
 *
 * 2. Los contadores son ACUMULADOS POR SESIÓN, NO deltas: cada evento
 *    (`start`/`interim`/`stop`) trae el total de ESA sesión hasta ese momento.
 *    TODA implementación de este puerto DEBE devolver UNA sola fila por
 *    `sourceUniqueId` (la más reciente) — `sourceUniqueId` ES la sesión, es la
 *    clave de idempotencia del ingest. Devolver dos eventos de la misma sesión
 *    MULTIPLICA el consumo.
 *
 * El anclaje por `usernames` es DEL PUERTO, no del caller: la implementación
 * DEBE filtrar por username en su propio WHERE. Van TODOS los usernames del
 * contrato (vigente + históricos) porque una re-provisión a mitad de mes crea un
 * username NUEVO — mirar solo el vigente borra la primera quincena.
 */

/** UNA sesión PPPoE (la fila más reciente de su `sourceUniqueId`). */
export interface UsageSession {
  /** Arranque de la sesión (instante UTC). FIJO durante toda la vida de la sesión. */
  startedAt: Date;
  /** Cierre de la sesión, o `null` si sigue VIVA (una sesión viva solapa siempre). */
  stoppedAt: Date | null;
  /** `bytesOut` acumulado de la sesión = DESCARGA del cliente. `bigint`: BigInt en la DB. */
  downloadBytes: bigint;
  /** `bytesIn` acumulado de la sesión = SUBIDA del cliente. */
  uploadBytes: bigint;
}

export interface UsageSessionsQuery {
  /** TODOS los logins PPPoE del contrato (= `RadiusEvent.username`), vigente + históricos. */
  usernames: string[];
  /** Arranque del período (instante UTC, inclusive). */
  from: Date;
  /** Fin del período (instante UTC, EXCLUSIVO). En la práctica es "ahora". */
  to: Date;
}

export interface UsageMetricsReader {
  /**
   * Las sesiones de `usernames` que SOLAPAN `[from, to)`:
   * `startedAt < to AND (stoppedAt IS NULL OR stoppedAt >= from)`.
   * UNA fila por sesión (dedup por `sourceUniqueId`, la más reciente), en UNA
   * sola query. El ORDEN no es parte del contrato: el prorrateo es conmutativo.
   */
  sessionsOverlappingRange(query: UsageSessionsQuery): Promise<UsageSession[]>;
}
