import type { TeamLocationPoint, TimeWindow } from '@domain/entities/team-location-point';
import type {
  IngestRunSummary,
  NewTeamLocationPoint,
  TeamIngestState,
  TeamLocationRepository,
} from '@domain/ports/TeamLocationRepository';
import { argentinaCalendarDay } from '@domain/services/iclassDateTime';

/**
 * Implementación in-memory del rastro GPS de cuadrillas. Es el adapter que usan los
 * tests de use case (nunca se mockea Prisma).
 *
 * Replica la MISMA semántica de deduplicación que la tabla real: la clave es
 * `(teamLogin, recordedAt, latitude, longitude)` y `sources` queda FUERA a propósito —
 * IClass emite el mismo fix físico por dos vías (origem 1 y 3 con timestamp y
 * coordenadas idénticos) y son UN punto, no dos.
 */
export class InMemoryTeamLocationRepository implements TeamLocationRepository {
  /** Clave de deduplicación → punto. */
  private readonly points = new Map<string, TeamLocationPoint>();
  private readonly ingestRuns: Array<IngestRunSummary & { startedAt: Date; finishedAt: Date }> = [];
  private readonly ingestStates = new Map<string, TeamIngestState>();

  /** Expuesto para asserts en tests. */
  get runs(): ReadonlyArray<IngestRunSummary & { startedAt: Date; finishedAt: Date }> {
    return this.ingestRuns;
  }

  private static key(p: TeamLocationPoint): string {
    return `${p.teamLogin}|${p.recordedAt.getTime()}|${p.latitude}|${p.longitude}`;
  }

  async saveMany(
    incoming: NewTeamLocationPoint[],
  ): Promise<{ inserted: number; duplicates: number }> {
    let inserted = 0;
    let duplicates = 0;

    for (const point of incoming) {
      const key = InMemoryTeamLocationRepository.key(point);
      const existing = this.points.get(key);

      if (!existing) {
        this.points.set(key, { ...point, sources: [...point.sources] });
        inserted++;
        continue;
      }

      duplicates++;
      // Deduplicar NO debe perder información: se acumulan los orígenes distintos.
      for (const source of point.sources) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
      }
    }

    return { inserted, duplicates };
  }

  async findByTeamInWindow(teamLogin: string, window: TimeWindow): Promise<TeamLocationPoint[]> {
    const from = window.from.getTime();
    const to = window.to.getTime();
    return [...this.points.values()]
      .filter((p) => p.teamLogin === teamLogin)
      .filter((p) => {
        const t = p.recordedAt.getTime();
        return t >= from && t <= to;
      })
      .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  }

  async findLatestPerTeam(): Promise<TeamLocationPoint[]> {
    const latest = new Map<string, TeamLocationPoint>();
    for (const point of this.points.values()) {
      const current = latest.get(point.teamLogin);
      if (!current || point.recordedAt.getTime() > current.recordedAt.getTime()) {
        latest.set(point.teamLogin, point);
      }
    }
    return [...latest.values()];
  }

  async findWatermark(teamLogin: string): Promise<Date | null> {
    let watermark: Date | null = null;
    for (const point of this.points.values()) {
      if (point.teamLogin !== teamLogin) continue;
      if (!watermark || point.recordedAt.getTime() > watermark.getTime()) {
        watermark = point.recordedAt;
      }
    }
    return watermark;
  }

  async findByTeamOnDay(teamLogin: string, argentinaDay: string): Promise<TeamLocationPoint[]> {
    // Se agrupa por día calendario ARGENTINO: 21:53 del 01-07 AR es 00:53 del 02-07 UTC,
    // y agrupar por UTC lo pondría en la jornada equivocada.
    return [...this.points.values()]
      .filter((p) => p.teamLogin === teamLogin && argentinaCalendarDay(p.recordedAt) === argentinaDay)
      .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const limit = cutoff.getTime();
    let purged = 0;
    for (const [key, point] of [...this.points.entries()]) {
      if (point.recordedAt.getTime() < limit) {
        this.points.delete(key);
        purged++;
      }
    }
    return purged;
  }

  async getIngestState(teamLogin: string): Promise<TeamIngestState | null> {
    return this.ingestStates.get(teamLogin) ?? null;
  }

  async markTeamComplete(teamLogin: string, watermark: Date | null): Promise<void> {
    const current = this.ingestStates.get(teamLogin);
    // El watermark contiguo NUNCA retrocede.
    const next =
      watermark && (!current?.contiguousWatermark || watermark > current.contiguousWatermark)
        ? watermark
        : current?.contiguousWatermark ?? null;
    this.ingestStates.set(teamLogin, {
      teamLogin,
      contiguousWatermark: next,
      lastIncompleteAt: current?.lastIncompleteAt ?? null,
      consecutiveIncomplete: 0,
    });
  }

  async markTeamIncomplete(teamLogin: string, at: Date): Promise<void> {
    const current = this.ingestStates.get(teamLogin);
    this.ingestStates.set(teamLogin, {
      teamLogin,
      // NO se toca: mientras haya hueco, la próxima corrida relee desde el mismo lugar.
      contiguousWatermark: current?.contiguousWatermark ?? null,
      lastIncompleteAt: at,
      consecutiveIncomplete: (current?.consecutiveIncomplete ?? 0) + 1,
    });
  }

  async recordIngestRun(
    summary: IngestRunSummary & { startedAt: Date; finishedAt: Date },
  ): Promise<void> {
    this.ingestRuns.push({ ...summary, incompleteTeams: [...summary.incompleteTeams] });
  }
}
