import type {
  UsageMetricsReader,
  UsageSession,
  UsageSessionsQuery,
} from '@domain/ports/UsageMetricsReader';
import { prisma } from '../../database/prisma';

/** Fila cruda del SELECT. El driver puede devolver los BigInt como bigint, number o string. */
interface SessionRow {
  startedAt: Date;
  stoppedAt: Date | null;
  downloadBytes: bigint | number | string;
  uploadBytes: bigint | number | string;
}

/**
 * portal-usage-metrics — adapter Prisma de `UsageMetricsReader`.
 *
 * SOLO FETCH, a propósito: devuelve las sesiones solapantes CRUDAS y el
 * prorrateo (fracción temporal + reparto diario) es `prorateUsageSessions`, la
 * función pura de application COMPARTIDA con el gemelo in-memory. Decisión
 * SQL-vs-Node justificada:
 *
 *  - La agregación dejó de ser un `GROUP BY` por día (fix C1): una sesión que
 *    cruza el borde del mes se atribuye por FRACCIÓN de su duración y se reparte
 *    uniforme entre sus días vivos. Ese cálculo en SQL puro (fracciones BigInt +
 *    `generate_series` por día + bordes de sesión viva) es ilegible, y además
 *    habría que reimplementarlo en el gemelo — dos copias de LA función que
 *    decide, la clase de bug exacta de `la-funcion-que-decide-no-es-la-que-se-testea`.
 *  - Traer crudo es barato POR CONSTRUCCIÓN: el WHERE ancla por los usernames
 *    del contrato y por solapamiento con UN mes → 3-30 filas por username/mes
 *    (una por SESIÓN — el ingest upsertea por `sourceUniqueId`), no la tabla de
 *    ~105k. UNA sola query, sin N+1.
 *
 * Cómo se lee el SQL:
 *
 *  - `DISTINCT ON ("sourceUniqueId")` deja UNA fila por SESIÓN. Los contadores
 *    de RADIUS son ACUMULADOS por sesión, NO deltas — devolver dos eventos de la
 *    misma sesión multiplica el consumo. El `ORDER BY "sourceUniqueId",
 *    "startedAt" DESC` se queda con el más reciente. (`sourceUniqueId` además es
 *    UNIQUE en la tabla porque es la clave de idempotencia del ingest: el
 *    `DISTINCT ON` es la regla explícita, no un parche — sobrevive a que el
 *    ingest deje de upsertear algún día.)
 *
 *  - VENTANA POR SOLAPAMIENTO (fix C1): `startedAt < to AND (stoppedAt IS NULL
 *    OR stoppedAt >= from)`. La sesión viva solapa siempre; la always-on nacida
 *    el mes anterior ENTRA (antes, `startedAt >= from` la excluía y el cliente
 *    veía 0 bytes).
 *
 *  - SARGABILIDAD (fix W1): `startedAt`/`stoppedAt` son `TIMESTAMP(3)`
 *    naive-UTC, así que se convierte EL PARÁMETRO (`::timestamptz AT TIME ZONE
 *    'UTC'` → naive UTC), nunca la columna — envolver la columna le esconde el
 *    rango al índice. El índice `RadiusEvent_username_startedAt_idx` sirve la
 *    igualdad por username y el rango de `startedAt`; la condición sobre
 *    `stoppedAt` es un filtro residual sobre esas filas.
 *
 *  - `username = ANY(...)`: TODOS los usernames del contrato (vigente +
 *    históricos) en una sola pasada — la re-provisión a mitad de mes no borra la
 *    primera quincena. El anclaje está en el WHERE del ADAPTER, no en el caller
 *    (mismo criterio que `PrismaPortalPaymentsReader`).
 *
 *  - `bytesOut AS "downloadBytes"` / `bytesIn AS "uploadBytes"`: el accounting
 *    está escrito desde el NAS — lo que SALE del NAS es lo que BAJA el cliente.
 *    Medido sobre prod: 41.572 sesiones con bytesOut>bytesIn contra 2.220 al
 *    revés, y 1.671 TB out contra 169 TB in (10:1).
 */
export class PrismaUsageMetricsReader implements UsageMetricsReader {
  async sessionsOverlappingRange(query: UsageSessionsQuery): Promise<UsageSession[]> {
    if (query.usernames.length === 0) return [];

    const rows = await prisma.$queryRaw<SessionRow[]>`
      SELECT DISTINCT ON ("sourceUniqueId")
             "startedAt",
             "stoppedAt",
             "bytesOut" AS "downloadBytes",
             "bytesIn"  AS "uploadBytes"
      FROM "RadiusEvent"
      WHERE username = ANY(${query.usernames})
        AND "startedAt" < (${query.to.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND ("stoppedAt" IS NULL OR "stoppedAt" >= (${query.from.toISOString()}::timestamptz AT TIME ZONE 'UTC'))
      ORDER BY "sourceUniqueId", "startedAt" DESC
    `;

    return rows.map((r) => ({
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt,
      downloadBytes: BigInt(r.downloadBytes),
      uploadBytes: BigInt(r.uploadBytes),
    }));
  }
}
