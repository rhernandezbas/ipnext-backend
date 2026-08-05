import type {
  UsageMetricsReader,
  UsageDailyBucket,
  UsageDailyUsageQuery,
} from '@domain/ports/UsageMetricsReader';
import { toArgentinaDateKey } from '@application/use-cases/messaging/reportsTimezone';

/** Un evento de accounting crudo, como el que ingesta el BE en `RadiusEvent`. */
export interface InMemoryRadiusUsageEvent {
  /** Clave de idempotencia del ingest. ES la sesión. */
  sourceUniqueId: string;
  username: string;
  startedAt: Date;
  /** SUBIDA del cliente, acumulada de la sesión hasta este evento. */
  bytesIn: bigint;
  /** DESCARGA del cliente, acumulada de la sesión hasta este evento. */
  bytesOut: bigint;
}

/**
 * portal-usage-metrics — gemelo in-memory de `UsageMetricsReader` para los tests
 * de use case (`GetPortalUsageMetrics`).
 *
 * Toma eventos CRUDOS (`record`), como los recibe el ingest, y replica las tres
 * reglas del puerto — las MISMAS que el `PrismaUsageMetricsReader` expresa en
 * SQL, para que in-memory y Prisma no puedan divergir en silencio:
 *
 *  1. filtra por `username` y por el rango `[from, to)` sobre el instante crudo;
 *  2. DEDUPLICA por `sourceUniqueId` quedándose con UN solo evento por sesión —
 *     el de `startedAt` mayor, y a igualdad el último registrado (que es
 *     exactamente lo que produce el upsert del ingest, porque `sourceUniqueId`
 *     es UNIQUE en la tabla). Los contadores son ACUMULADOS, no deltas: sumar
 *     los eventos multiplicaría el consumo;
 *  3. bucketea por día en hora LOCAL de Argentina (UTC-3, mismo helper que el
 *     resto del proyecto) y mapea `bytesOut` -> DESCARGA, `bytesIn` -> SUBIDA.
 *
 * `queries` guarda cada llamada: deja assertear el rango pedido y —más
 * importante— que a un contrato ajeno NI SE LE PREGUNTA.
 */
export class InMemoryUsageMetricsReader implements UsageMetricsReader {
  private readonly events: InMemoryRadiusUsageEvent[] = [];
  readonly queries: UsageDailyUsageQuery[] = [];

  record(event: InMemoryRadiusUsageEvent): void {
    this.events.push(event);
  }

  clear(): void {
    this.events.length = 0;
    this.queries.length = 0;
  }

  async dailyUsageByUsername(query: UsageDailyUsageQuery): Promise<UsageDailyBucket[]> {
    this.queries.push(query);

    // (1) Anclaje por username + rango semi-abierto [from, to).
    const inScope = this.events.filter(
      (e) =>
        e.username === query.username &&
        e.startedAt.getTime() >= query.from.getTime() &&
        e.startedAt.getTime() < query.to.getTime(),
    );

    // (2) UNA fila por sesión. Equivalente al `DISTINCT ON ("sourceUniqueId")
    //     ... ORDER BY "sourceUniqueId", "startedAt" DESC` del adapter Prisma.
    const lastPerSession = new Map<string, InMemoryRadiusUsageEvent>();
    for (const e of inScope) {
      const prev = lastPerSession.get(e.sourceUniqueId);
      if (!prev || e.startedAt.getTime() >= prev.startedAt.getTime()) {
        lastPerSession.set(e.sourceUniqueId, e);
      }
    }

    // (3) Bucketing por día AR. bytesOut -> DESCARGA, bytesIn -> SUBIDA.
    const byDate = new Map<string, UsageDailyBucket>();
    for (const e of lastPerSession.values()) {
      const date = toArgentinaDateKey(e.startedAt.toISOString());
      const bucket = byDate.get(date) ?? { date, downloadBytes: 0n, uploadBytes: 0n };
      byDate.set(date, {
        date,
        downloadBytes: bucket.downloadBytes + e.bytesOut,
        uploadBytes: bucket.uploadBytes + e.bytesIn,
      });
    }

    return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
}
