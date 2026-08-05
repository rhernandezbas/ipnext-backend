import type {
  UsageMetricsReader,
  UsageDailyBucket,
  UsageDailyUsageQuery,
} from '@domain/ports/UsageMetricsReader';
import { prisma } from '../../database/prisma';

/** Fila cruda del GROUP BY. El driver puede devolver el SUM como bigint, number o string. */
interface UsageRow {
  date: string;
  downloadBytes: bigint | number | string;
  uploadBytes: bigint | number | string;
}

/**
 * portal-usage-metrics — adapter Prisma de `UsageMetricsReader`.
 *
 * `$queryRaw` y no el query builder de Prisma, a propósito: Prisma no sabe
 * expresar ni el `DISTINCT ON` ni el `AT TIME ZONE` que esta lectura necesita.
 * Con `groupBy` habría que traer las sesiones crudas a Node para deduplicarlas y
 * bucketearlas — sobre una tabla de ~105k filas que crece, es justo lo que no se
 * puede hacer. Acá TODO baja a la base y vuelve un puñado de filas (una por día
 * del mes, ~31 como máximo). UNA sola query, sin N+1.
 *
 * Cómo se lee el SQL:
 *
 *  - CTE `ultimo_por_sesion`: `DISTINCT ON ("sourceUniqueId")` deja UNA fila por
 *    SESIÓN. Los contadores de RADIUS son ACUMULADOS por sesión, NO deltas —
 *    cada evento (`start`/`interim`/`stop`) trae el total de esa sesión hasta ese
 *    momento, así que sumar los eventos MULTIPLICA el consumo. El `ORDER BY
 *    "sourceUniqueId", "startedAt" DESC` se queda con el más reciente.
 *    (`sourceUniqueId` además es UNIQUE en la tabla porque es la clave de
 *    idempotencia del ingest: el `DISTINCT ON` es la regla explícita, no un
 *    parche — sobrevive a que el ingest deje de upsertear algún día.)
 *
 *  - SELECT final: `SUM("bytesOut")` es la DESCARGA del cliente y `SUM("bytesIn")`
 *    la SUBIDA. El accounting está escrito desde el NAS: lo que SALE del NAS es
 *    lo que BAJA el cliente. Medido sobre la población real de prod: 41.572
 *    sesiones con bytesOut>bytesIn contra 2.220 al revés, y 1.671 TB out contra
 *    169 TB in (10:1). Invertirlo le muestra al cliente que subió 10 veces lo
 *    que bajó.
 *
 *  - Día en zona AR: `startedAt` es `TIMESTAMP(3)` naive-UTC, así que
 *    `AT TIME ZONE 'UTC'` lo vuelve un instante y `AT TIME ZONE
 *    'America/Argentina/Buenos_Aires'` lo lleva a hora de pared local — misma
 *    forma que `PrismaConversationEventRepository` / `PrismaChatMessageRepository`.
 *    El FILTRO por rango compara el instante crudo, `[from, to)` semi-abierto.
 *
 *  - El anclaje por `username` está en el WHERE del ADAPTER, no en el caller: el
 *    servidor es la autoridad (mismo criterio que `PrismaPortalPaymentsReader`).
 *
 * El índice `RadiusEvent_username_startedAt_idx` cubre el WHERE entero.
 */
export class PrismaUsageMetricsReader implements UsageMetricsReader {
  async dailyUsageByUsername(query: UsageDailyUsageQuery): Promise<UsageDailyBucket[]> {
    const rows = await prisma.$queryRaw<UsageRow[]>`
      WITH ultimo_por_sesion AS (
        SELECT DISTINCT ON ("sourceUniqueId")
               "sourceUniqueId", "bytesIn", "bytesOut", "startedAt"
        FROM "RadiusEvent"
        WHERE username = ${query.username}
          AND ("startedAt" AT TIME ZONE 'UTC') >= ${query.from.toISOString()}::timestamptz
          AND ("startedAt" AT TIME ZONE 'UTC') <  ${query.to.toISOString()}::timestamptz
        ORDER BY "sourceUniqueId", "startedAt" DESC
      )
      SELECT to_char(
               ("startedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date,
               'YYYY-MM-DD'
             ) AS date,
             SUM("bytesOut")::bigint AS "downloadBytes",
             SUM("bytesIn")::bigint  AS "uploadBytes"
      FROM ultimo_por_sesion
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    return rows.map((r) => ({
      date: r.date,
      downloadBytes: BigInt(r.downloadBytes),
      uploadBytes: BigInt(r.uploadBytes),
    }));
  }
}
