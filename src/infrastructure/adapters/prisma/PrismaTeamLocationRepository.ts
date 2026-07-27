import type { TeamLocationPoint, TimeWindow } from '@domain/entities/team-location-point';
import type {
  IngestRunSummary,
  NewTeamLocationPoint,
  TeamIngestState,
  TeamLocationRepository,
} from '@domain/ports/TeamLocationRepository';
import { Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma';

/** Offset fijo de Argentina (UTC-3, sin DST desde 2009), en ms. */
const ARGENTINA_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Filas por statement en el upsert.
 *
 * `createMany` de Prisma chunkea solo (32.766 bind values en postgres), pero **`$queryRaw`
 * NO**: al pasar al `ON CONFLICT DO UPDATE` crudo se perdió esa red. Con 6 parámetros por
 * fila, un backfill de 20.000 puntos daría 120.000 binds contra el tope de 65.535 de
 * Postgres — y el fallo sería determinista y eterno, porque el watermark no avanzaría.
 * 500 filas = 3.000 binds, con margen de sobra. Mismo criterio que el `UPSERT_CHUNK_SIZE`
 * de los repos de RADIUS.
 */
const UPSERT_CHUNK_SIZE = 500;

interface TeamLocationRow {
  teamLogin: string;
  latitude: number;
  longitude: number;
  recordedAt: Date;
  accuracyM: number | null;
  sources: number[];
}

function mapRow(row: TeamLocationRow): TeamLocationPoint {
  return {
    teamLogin: row.teamLogin,
    latitude: row.latitude,
    longitude: row.longitude,
    recordedAt: row.recordedAt instanceof Date ? row.recordedAt : new Date(row.recordedAt),
    accuracyMeters: row.accuracyM ?? null,
    sources: row.sources ?? [],
  };
}

/** Identidad natural del punto — `sources` queda FUERA a propósito. */
function dedupKey(p: TeamLocationPoint): string {
  return `${p.teamLogin}|${p.recordedAt.getTime()}|${p.latitude}|${p.longitude}`;
}

/**
 * Persistencia Prisma del rastro GPS de cuadrillas.
 *
 * La deduplicación ocurre en DOS niveles y los dos son necesarios:
 *  1. **En memoria, antes del INSERT**: colapsa el mismo fix llegado por dos `origem`
 *     distintos dentro del mismo lote, MERGEANDO los orígenes. Si se delegara todo al
 *     `ON CONFLICT` de la base, el segundo se descartaría y se perdería el origen.
 *  2. **En la base, vía el unique compuesto** + `skipDuplicates`: hace el ingest
 *     idempotente entre corridas, sin necesidad de leer antes de escribir.
 */
export class PrismaTeamLocationRepository implements TeamLocationRepository {
  async saveMany(
    incoming: NewTeamLocationPoint[],
  ): Promise<{ inserted: number; duplicates: number }> {
    if (incoming.length === 0) return { inserted: 0, duplicates: 0 };

    // Nivel 1 — dedup intra-lote conservando todos los orígenes.
    //
    // ⚠️ ESTE PASO ES LOAD-BEARING, no una optimización. Verificado contra la Postgres
    // real: dos filas del MISMO statement que colisionan en la tupla única hacen fallar
    // el upsert entero con `ON CONFLICT DO UPDATE command cannot affect row a second
    // time`. Como IClass emite el mismo fix por dos `origem`, el lote SIEMPRE trae
    // colisiones — sin este colapso previo, `saveMany` reventaría en cada corrida.
    //
    // `dedupKey` es EXACTAMENTE equivalente al unique de la base (verificado): un `number`
    // de JS ES un float8, y `String(-0) === '0'` igual que `-0.0 = 0.0` en Postgres.
    // Si alguien toca esa clave, esto explota.
    const collapsed = new Map<string, NewTeamLocationPoint>();
    for (const point of incoming) {
      const key = dedupKey(point);
      const existing = collapsed.get(key);
      if (!existing) {
        collapsed.set(key, { ...point, sources: [...point.sources] });
        continue;
      }
      for (const source of point.sources) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
      }
    }

    const data = [...collapsed.values()].map((p) => ({
      teamLogin: p.teamLogin,
      latitude: p.latitude,
      longitude: p.longitude,
      recordedAt: p.recordedAt,
      accuracyM: p.accuracyMeters,
      sources: p.sources,
    }));

    // Nivel 2 — idempotencia entre corridas Y merge de `sources` (hallazgo 4.3).
    //
    // `createMany({ skipDuplicates: true })` DESCARTA la fila entera en el conflicto, así
    // que un `origem` que llega en otra corrida (o cruzando un borde de página) se perdía
    // en silencio — contradiciendo la promesa escrita en el schema, en la entidad y en
    // este mismo docblock. El in-memory sí mergeaba, con lo que los contadores coincidían
    // y los DATOS no: ningún assert de conteo podía detectarlo.
    //
    // `ON CONFLICT DO UPDATE` con unión de arrays lo resuelve en una sola ida.

    let inserted = 0;
    let updated = 0;

    for (let i = 0; i < data.length; i += UPSERT_CHUNK_SIZE) {
      const chunk = data.slice(i, i + UPSERT_CHUNK_SIZE);
      const { insertedInChunk, updatedInChunk } = await this.upsertChunk(chunk);
      inserted += insertedInChunk;
      updated += updatedInChunk;
    }

    // Duplicados = los colapsados intra-lote + los que ya existían en la base.
    return { inserted, duplicates: incoming.length - data.length + updated };
  }

  /** Un statement de upsert. Ver `UPSERT_CHUNK_SIZE` para por qué se chunkea. */
  private async upsertChunk(
    chunk: Array<{
      teamLogin: string;
      latitude: number;
      longitude: number;
      recordedAt: Date;
      accuracyM: number | null;
      sources: number[];
    }>,
  ): Promise<{ insertedInChunk: number; updatedInChunk: number }> {
    const rows = chunk.map(
      (d) =>
        Prisma.sql`(gen_random_uuid(), ${d.teamLogin}, ${d.latitude}, ${d.longitude}, ${d.recordedAt}, ${d.accuracyM}, ${d.sources}::int[])`,
    );

    // Sobre `gen_random_uuid()`: rompe la convención de los otros 40+ modelos, que usan
    // `@default(uuid())` del cliente. Es deliberado — este INSERT es SQL crudo y no pasa
    // por el generador de Prisma. **Verificado contra la Postgres de prod (17.10)**: la
    // función es CORE (vive en `pg_catalog`, nativa desde PG13), NO requiere `pgcrypto`
    // —que de hecho no está instalada— y genera UUID v4 válidos y únicos.
    //
    // `xmax = 0` distingue INSERT de UPDATE fila por fila: con ON CONFLICT DO UPDATE
    // todas las filas cuentan como "afectadas", así que `$executeRaw` devolvería siempre
    // el total y los contadores mentirían — justo la clase de defecto que este change
    // viene a eliminar.
    const outcome = await prisma.$queryRaw<Array<{ was_insert: boolean }>>(Prisma.sql`
      INSERT INTO "TeamLocationPoint" ("id","teamLogin","latitude","longitude","recordedAt","accuracyM","sources")
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("teamLogin","recordedAt","latitude","longitude") DO UPDATE
        SET "sources" = (
          SELECT ARRAY(SELECT DISTINCT unnest("TeamLocationPoint"."sources" || EXCLUDED."sources") ORDER BY 1)
        )
      RETURNING (xmax = 0) AS was_insert
    `);

    const insertedInChunk = outcome.filter((r) => r.was_insert).length;
    return { insertedInChunk, updatedInChunk: outcome.length - insertedInChunk };
  }

  async findByTeamInWindow(teamLogin: string, window: TimeWindow): Promise<TeamLocationPoint[]> {
    const rows = await prisma.teamLocationPoint.findMany({
      where: { teamLogin, recordedAt: { gte: window.from, lte: window.to } },
      orderBy: { recordedAt: 'asc' },
    });
    return rows.map(mapRow);
  }

  /**
   * Último punto de cada cuadrilla, con `DISTINCT ON` REAL de Postgres.
   *
   * NO se usa el `distinct` de Prisma (hallazgo 4.1): verificado compilando el query,
   * **Prisma 7 no lo traduce a `DISTINCT ON`** — trae TODAS las filas y deduplica en
   * Node. A 12 meses de retención son ~432.000 filas (~90 MB) transferidas en CADA
   * request del mapa en vivo, para quedarse con 6. El comentario anterior afirmaba lo
   * contrario y era falso.
   *
   * **Costo real, MEDIDO contra la Postgres de prod (17.10) con 432.000 filas** — la
   * proyección a 12 meses:
   *
   *     Unique → Index Scan using (teamLogin, recordedAt DESC)
   *     actual rows=432000 · 52k buffers · 342 ms
   *
   * O sea: el índice evita el Sort, pero **el DISTINCT ON recorre igual TODAS las filas**.
   * Postgres no hace loose/skip index scan, así que esto es O(N), no O(cuadrillas). Una
   * versión anterior de este comentario daba a entender que el índice lo volvía barato:
   * era falso.
   *
   * Aun así la ganancia contra el `distinct` de Prisma es enorme (no transfiere ~90 MB a
   * Node en cada request). Si 342 ms molestan cuando la tabla crezca, el siguiente paso
   * es un `LATERAL` sobre la lista de cuadrillas: ~6 index lookups en vez de un scan.
   */
  async findLatestPerTeam(): Promise<TeamLocationPoint[]> {
    const rows = await prisma.$queryRaw<TeamLocationRow[]>(Prisma.sql`
      SELECT DISTINCT ON ("teamLogin")
             "teamLogin", "latitude", "longitude", "recordedAt", "accuracyM", "sources"
      FROM "TeamLocationPoint"
      ORDER BY "teamLogin", "recordedAt" DESC
    `);
    return rows.map(mapRow);
  }

  async findWatermark(teamLogin: string): Promise<Date | null> {
    const row = await prisma.teamLocationPoint.findFirst({
      where: { teamLogin },
      orderBy: { recordedAt: 'desc' },
    });
    return row ? row.recordedAt : null;
  }

  /**
   * Puntos de un día calendario ARGENTINO.
   *
   * Valida el calendario (hallazgo 4.2): `Date.UTC(2026, 1, 31)` DESBORDA al 3 de marzo,
   * así que `?day=2026-02-31` devolvía el rastro real de OTRO DÍA etiquetado con la fecha
   * pedida — en un endpoint de auditoría sobre personas. El in-memory devolvía `[]`, o sea
   * que además los tests de use case mentían sobre el comportamiento de producción.
   */
  async findByTeamOnDay(teamLogin: string, argentinaDay: string): Promise<TeamLocationPoint[]> {
    const [year, month, day] = argentinaDay.split('-').map(Number);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return [];

    const asUtc = Date.UTC(year, month - 1, day);
    const roundTrip = new Date(asUtc);
    if (
      roundTrip.getUTCFullYear() !== year ||
      roundTrip.getUTCMonth() !== month - 1 ||
      roundTrip.getUTCDate() !== day
    ) {
      // Día inexistente: NO se sirve el rastro de la fecha a la que desbordaría.
      return [];
    }

    // El día calendario AR arranca a las 03:00 UTC.
    const startUtc = new Date(asUtc + ARGENTINA_OFFSET_MS);
    const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);

    const rows = await prisma.teamLocationPoint.findMany({
      where: { teamLogin, recordedAt: { gte: startUtc, lt: endUtc } },
      orderBy: { recordedAt: 'asc' },
    });
    return rows.map(mapRow);
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const res = await prisma.teamLocationPoint.deleteMany({
      where: { recordedAt: { lt: cutoff } },
    });
    return res.count;
  }

  async getIngestState(teamLogin: string): Promise<TeamIngestState | null> {
    const row = await prisma.teamLocationIngestState.findUnique({ where: { teamLogin } });
    if (!row) return null;
    return {
      teamLogin: row.teamLogin,
      contiguousWatermark: row.contiguousWatermark,
      lastIncompleteAt: row.lastIncompleteAt,
      consecutiveIncomplete: row.consecutiveIncomplete,
    };
  }

  async markTeamComplete(teamLogin: string, watermark: Date | null): Promise<void> {
    const current = await prisma.teamLocationIngestState.findUnique({ where: { teamLogin } });
    // El watermark contiguo NUNCA retrocede.
    const next =
      watermark && (!current?.contiguousWatermark || watermark > current.contiguousWatermark)
        ? watermark
        : current?.contiguousWatermark ?? null;

    await prisma.teamLocationIngestState.upsert({
      where: { teamLogin },
      create: { teamLogin, contiguousWatermark: next, consecutiveIncomplete: 0 },
      update: { contiguousWatermark: next, consecutiveIncomplete: 0 },
    });
  }

  async markTeamIncomplete(teamLogin: string, at: Date): Promise<void> {
    await prisma.teamLocationIngestState.upsert({
      where: { teamLogin },
      // El `contiguousWatermark` NO se toca: mientras haya hueco, la corrida siguiente
      // vuelve a pedir desde el mismo lugar en vez de saltar por encima.
      create: { teamLogin, lastIncompleteAt: at, consecutiveIncomplete: 1 },
      update: { lastIncompleteAt: at, consecutiveIncomplete: { increment: 1 } },
    });
  }

  async recordIngestRun(
    summary: IngestRunSummary & { startedAt: Date; finishedAt: Date },
  ): Promise<void> {
    await prisma.teamLocationIngestRun.create({
      data: {
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        teamsProcessed: summary.teamsProcessed,
        pointsNew: summary.pointsNew,
        pointsDuplicate: summary.pointsDuplicate,
        pointsPurged: summary.pointsPurged,
        pagesRead: summary.pagesRead,
        pointsDropped: summary.pointsDropped,
        incompleteTeams: summary.incompleteTeams,
      },
    });
  }
}
