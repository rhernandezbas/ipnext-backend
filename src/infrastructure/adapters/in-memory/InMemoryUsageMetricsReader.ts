import type {
  UsageMetricsReader,
  UsageSession,
  UsageSessionsQuery,
} from '@domain/ports/UsageMetricsReader';

/** Un evento de accounting crudo, como el que ingesta el BE en `RadiusEvent`. */
export interface InMemoryRadiusUsageEvent {
  /** Clave de idempotencia del ingest. ES la sesión. */
  sourceUniqueId: string;
  username: string;
  startedAt: Date;
  /** Cierre de la sesión. Omitido/`null` = sesión VIVA (como la deja un start/interim). */
  stoppedAt?: Date | null;
  /** SUBIDA del cliente, acumulada de la sesión hasta este evento. */
  bytesIn: bigint;
  /** DESCARGA del cliente, acumulada de la sesión hasta este evento. */
  bytesOut: bigint;
}

/**
 * portal-usage-metrics — gemelo in-memory de `UsageMetricsReader` para los tests
 * de use case (`GetPortalUsageMetrics`).
 *
 * Toma eventos CRUDOS (`record`), como los recibe el ingest, y replica las
 * reglas del puerto — las MISMAS que el `PrismaUsageMetricsReader` expresa en
 * SQL, para que in-memory y Prisma no puedan divergir en silencio:
 *
 *  1. DEDUPLICA por `sourceUniqueId` quedándose con UN solo evento por sesión —
 *     el de `startedAt` mayor, y a igualdad el último registrado (que es
 *     exactamente lo que produce el upsert del ingest, porque `sourceUniqueId`
 *     es UNIQUE en la tabla). Los contadores son ACUMULADOS, no deltas. El dedup
 *     va ANTES del filtro, igual que en prod: allá la tabla YA está deduplicada
 *     cuando el WHERE corre.
 *  2. filtra por `usernames` y por SOLAPAMIENTO con `[from, to)`:
 *     `startedAt < to AND (stoppedAt IS NULL OR stoppedAt >= from)` — la sesión
 *     viva solapa siempre (fix C1).
 *  3. mapea `bytesOut` -> DESCARGA (`downloadBytes`), `bytesIn` -> SUBIDA
 *     (`uploadBytes`).
 *
 * El PRORRATEO no vive acá: es `prorateUsageSessions` (application), UNA función
 * compartida con el camino de prod — este gemelo solo replica el FETCH.
 *
 * `queries` guarda cada llamada: deja assertear el rango y los usernames
 * pedidos y —más importante— que a un contrato ajeno NI SE LE PREGUNTA.
 */
export class InMemoryUsageMetricsReader implements UsageMetricsReader {
  private readonly events: InMemoryRadiusUsageEvent[] = [];
  readonly queries: UsageSessionsQuery[] = [];

  record(event: InMemoryRadiusUsageEvent): void {
    this.events.push(event);
  }

  clear(): void {
    this.events.length = 0;
    this.queries.length = 0;
  }

  async sessionsOverlappingRange(query: UsageSessionsQuery): Promise<UsageSession[]> {
    this.queries.push(query);

    // (1) UNA fila por sesión — réplica del upsert del ingest (y del `DISTINCT ON
    //     ("sourceUniqueId") ... ORDER BY "sourceUniqueId", "startedAt" DESC`).
    const lastPerSession = new Map<string, InMemoryRadiusUsageEvent>();
    for (const e of this.events) {
      const prev = lastPerSession.get(e.sourceUniqueId);
      if (!prev || e.startedAt.getTime() >= prev.startedAt.getTime()) {
        lastPerSession.set(e.sourceUniqueId, e);
      }
    }

    // (2) Anclaje por usernames + ventana POR SOLAPAMIENTO con [from, to).
    // (3) bytesOut -> DESCARGA, bytesIn -> SUBIDA.
    return [...lastPerSession.values()]
      .filter(
        (e) =>
          query.usernames.includes(e.username) &&
          e.startedAt.getTime() < query.to.getTime() &&
          (e.stoppedAt == null || e.stoppedAt.getTime() >= query.from.getTime()),
      )
      .map((e) => ({
        startedAt: e.startedAt,
        stoppedAt: e.stoppedAt ?? null,
        downloadBytes: e.bytesOut,
        uploadBytes: e.bytesIn,
      }));
  }
}
