import { RadiusEvent, RadiusEventType } from '@domain/entities/radius-event';
import {
  RadiusEventRepository,
  RadiusEventFilters,
  RadiusEventUpsert,
  PaginatedResult,
  LastConnectionSummary,
} from '@domain/ports/RadiusEventRepository';
import { prisma } from '../../database/prisma';

/**
 * PrismaRadiusEventRepository — adapter de persistencia para RadiusEvent.
 *
 * - `upsertMany`: upsert atómico por `sourceUniqueId` (ON CONFLICT → update).
 *   Usa `Promise.all` de upserts individuales (Prisma no tiene createManyAndReturn
 *   ni upsertMany con ON CONFLICT personalizado más allá del unique key).
 * - `list`: filtra + pagina. BigInt → bigint (ya viene de Prisma como bigint).
 * - `lastEventByUsername`: una query GROUP BY + MAX para evitar N+1.
 * - `deleteOlderThan`: DELETE WHERE startedAt < cutoff (indexed).
 *
 * ⚠️  El client Prisma es el singleton global. En prod `prisma generate` corre en el Dockerfile.
 *     Usamos `(prisma as any).radiusEvent` para sortear el no-regen local (patrón del proyecto).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function model(): any {
  return (prisma as any).radiusEvent;
}

export class PrismaRadiusEventRepository implements RadiusEventRepository {
  async upsertMany(rows: RadiusEventUpsert[]): Promise<number> {
    if (rows.length === 0) return 0;

    // FIX7a: envolver en $transaction para atomicidad.
    // Antes: Promise.all de upserts independientes → fallo parcial no se rollbackea
    // y count devuelto era rows.length (mentía si alguno fallaba).
    // Con $transaction: todos los upserts son atómicos. Si uno falla, rollback total.
    await (prisma as any).$transaction(
      rows.map((row) =>
        model().upsert({
          where: { sourceUniqueId: row.sourceUniqueId },
          create: {
            sourceUniqueId: row.sourceUniqueId,
            username:       row.username,
            nasIpAddress:   row.nasIpAddress,
            nasId:          row.nasId,
            framedIp:       row.framedIp,
            macAddress:     row.macAddress,
            vlanId:         row.vlanId,
            startedAt:      row.startedAt,
            stoppedAt:      row.stoppedAt,
            sessionTime:    row.sessionTime,
            bytesIn:        row.bytesIn,
            bytesOut:       row.bytesOut,
            eventType:      row.eventType,
            status:         row.status,
          },
          update: {
            // On re-ingest: update MUTABLE fields only (session may have closed since last tick).
            // FIX7b: username/nasIpAddress/startedAt son identidad de la sesion → NO actualizar.
            stoppedAt:   row.stoppedAt,
            sessionTime: row.sessionTime,
            bytesIn:     row.bytesIn,
            bytesOut:    row.bytesOut,
            eventType:   row.eventType,
            status:      row.status,
            // nasId may have been resolved on a later tick
            nasId:       row.nasId,
            framedIp:    row.framedIp,
            macAddress:  row.macAddress,
            vlanId:      row.vlanId,
          },
        }),
      ),
    );

    return rows.length;
  }

  async list(filters: RadiusEventFilters): Promise<PaginatedResult<RadiusEvent>> {
    const where = buildWhere(filters);
    const skip  = (filters.page - 1) * filters.pageSize;

    const [rows, total] = await Promise.all([
      model().findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { sourceUniqueId: 'asc' }],
        skip,
        take: filters.pageSize,
      }),
      model().count({ where }),
    ]);

    return {
      data:     (rows as unknown[]).map(toEntity),
      total,
      page:     filters.page,
      pageSize: filters.pageSize,
    };
  }

  async lastEventByUsername(
    nasId: string,
    usernames: string[],
  ): Promise<Map<string, LastConnectionSummary>> {
    if (usernames.length === 0) return new Map();

    // Una sola query: busca todos los eventos del nasId+usernames ordenados por startedAt DESC.
    // Luego en JS: calculamos lastStartedAt (más reciente), lastStoppedAt (último cerrado),
    // currentlyOnline (hay alguno con stoppedAt=null). Una pasada O(N) — sin N+1.
    const rows = await model().findMany({
      where: {
        nasId,
        username: { in: usernames },
      },
      orderBy: { startedAt: 'desc' },
    });

    // Acumuladores por username
    const latestRow  = new Map<string, ReturnType<typeof toEntity>>();
    const lastClosed = new Map<string, string>(); // username → stoppedAt ISO
    const hasOnline  = new Map<string, boolean>();

    for (const rawRow of rows as unknown[]) {
      const e = toEntity(rawRow);
      // Primer registro con startedAt más alto = el más reciente (ya está ordenado DESC)
      if (!latestRow.has(e.username)) latestRow.set(e.username, e);
      // Último cerrado (startedAt DESC; el primero con stoppedAt !== null que veamos por username)
      if (e.stoppedAt !== null && !lastClosed.has(e.username)) {
        lastClosed.set(e.username, e.stoppedAt);
      }
      // ¿Alguna sesión activa?
      if (e.stoppedAt === null) hasOnline.set(e.username, true);
    }

    const result = new Map<string, LastConnectionSummary>();
    for (const username of usernames) {
      const latest = latestRow.get(username);
      if (!latest) continue;
      result.set(username, {
        lastStartedAt:  latest.startedAt,
        lastStoppedAt:  lastClosed.get(username) ?? null,
        currentlyOnline: hasOnline.get(username) ?? false,
        lastFramedIp:   latest.framedIp,
        lastVlanId:     latest.vlanId,
      });
    }

    return result;
  }

  /**
   * CAS-1 — para cada username, la macAddress del "mejor" evento: prefiere status online
   * (stoppedAt IS NULL); si no hay online, el de startedAt más reciente. Solo eventos con
   * macAddress IS NOT NULL. `DISTINCT ON (username)` + `ORDER BY username, ("stoppedAt" IS
   * NULL) DESC, "startedAt" DESC` da EXACTAMENTE ese ganador en una sola pasada — ninguna
   * fila con mac null entra en la comparación (WHERE), así que un usuario con eventos pero
   * sin ningún mac queda ausente del resultado. Chunked de a 1000 usernames por query
   * (protección ante lotes de ~5k) — NUNCA N+1.
   */
  async latestMacByUsernames(usernames: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (usernames.length === 0) return result;

    const CHUNK_SIZE = 1000;
    for (let i = 0; i < usernames.length; i += CHUNK_SIZE) {
      const chunk = usernames.slice(i, i + CHUNK_SIZE);
      const rows = await prisma.$queryRaw<Array<{ username: string; macAddress: string }>>`
        SELECT DISTINCT ON (username) username, "macAddress"
        FROM "RadiusEvent"
        WHERE username = ANY(${chunk})
          AND "macAddress" IS NOT NULL
        ORDER BY username, ("stoppedAt" IS NULL) DESC, "startedAt" DESC
      `;
      for (const row of rows) {
        result.set(row.username, row.macAddress);
      }
    }

    return result;
  }

  async deleteOlderThan(cutoff: Date, batchSize: number): Promise<number> {
    let totalDeleted = 0;

    // Batched delete: find IDs, then delete by those IDs (avoids holding a huge lock).
    while (true) {
      const rows = await model().findMany({
        where:   { startedAt: { lt: cutoff } },
        select:  { id: true },
        take:    batchSize,
      });

      if (rows.length === 0) break;

      const ids = (rows as Array<{ id: string }>).map((r) => r.id);
      const { count } = await model().deleteMany({ where: { id: { in: ids } } });
      totalDeleted += count;

      if (rows.length < batchSize) break;
    }

    return totalDeleted;
  }
}

// ── Mappers ─────────────────────────────────────────────────────────────────

function buildWhere(filters: RadiusEventFilters): Record<string, unknown> {
  const where: Record<string, unknown> = {};

  if (filters.username  !== undefined) where['username']  = filters.username;
  if (filters.nasId     !== undefined) where['nasId']     = filters.nasId;
  if (filters.vlanId    !== undefined) where['vlanId']    = filters.vlanId;
  if (filters.status    !== undefined) where['status']    = filters.status;
  if (filters.eventType !== undefined) where['eventType'] = filters.eventType;

  if (filters.from !== undefined || filters.to !== undefined) {
    const startedAt: Record<string, unknown> = {};
    if (filters.from !== undefined) startedAt['gte'] = filters.from;
    if (filters.to   !== undefined) startedAt['lte'] = filters.to;
    where['startedAt'] = startedAt;
  }

  return where;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toEntity(row: any): RadiusEvent {
  return {
    id:             row.id,
    sourceUniqueId: row.sourceUniqueId,
    username:       row.username,
    nasIpAddress:   row.nasIpAddress,
    nasId:          row.nasId ?? null,
    framedIp:       row.framedIp ?? null,
    macAddress:     row.macAddress ?? null,
    vlanId:         row.vlanId ?? null,
    startedAt:      row.startedAt instanceof Date ? row.startedAt.toISOString() : String(row.startedAt),
    stoppedAt:      row.stoppedAt instanceof Date ? row.stoppedAt.toISOString() : (row.stoppedAt ?? null),
    sessionTime:    row.sessionTime ?? null,
    bytesIn:        typeof row.bytesIn  === 'bigint' ? row.bytesIn  : BigInt(row.bytesIn  ?? 0),
    bytesOut:       typeof row.bytesOut === 'bigint' ? row.bytesOut : BigInt(row.bytesOut ?? 0),
    eventType:      row.eventType as RadiusEventType,
    status:         row.status,
    createdAt:      row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt:      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}
