import type { IngestRunSummary, TeamLocationRepository } from '@domain/ports/TeamLocationRepository';
import type { TeamLocationSource } from '@domain/ports/TeamLocationSource';

/**
 * Trae el rastro GPS de todas las cuadrillas desde IClass y lo persiste en Prominense.
 *
 * Razón de ser: IClass retiene los breadcrumbs ~30 días ROLLING. Sin esta copia no hay
 * auditoría histórica posible — el dato se borra solo.
 *
 * Dos principios que gobiernan el diseño:
 *
 *  1. **Nunca reportar éxito con datos parciales.** El modo de falla peligroso de este
 *     ingest es el SILENCIOSO: traer de menos y parecer exitoso. Toda cuadrilla cuyo
 *     rastro no se pudo leer completo queda listada en `incompleteTeams`.
 *  2. **Una cuadrilla que falla no aborta la corrida.** Lo que sí se pudo leer se
 *     persiste igual: descartarlo perdería dato que expira en 30 días y no vuelve.
 */

/** Retención propia, en meses (decisión del usuario 2026-07-26). */
const DEFAULT_RETENTION_MONTHS = 12;

export interface IngestTeamLocationsDeps {
  source: TeamLocationSource;
  repo: TeamLocationRepository;
  now?: () => Date;
  retentionMonths?: number;
}

export class IngestTeamLocations {
  private readonly source: TeamLocationSource;
  private readonly repo: TeamLocationRepository;
  private readonly now: () => Date;
  private readonly retentionMonths: number;

  constructor(deps: IngestTeamLocationsDeps) {
    this.source = deps.source;
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date());
    this.retentionMonths = deps.retentionMonths ?? DEFAULT_RETENTION_MONTHS;
  }

  async execute(): Promise<IngestRunSummary> {
    const startedAt = this.now();

    let teamsProcessed = 0;
    let pointsNew = 0;
    let pointsDuplicate = 0;
    let pagesRead = 0;
    let pointsDropped = 0;
    // Set y no array: una cuadrilla puede fallar por `trail.incomplete` Y por excepción,
    // y contarla dos veces distorsiona cualquier alerta basada en la cantidad.
    const incompleteTeams = new Set<string>();

    const teams = await this.source.listTeams();

    for (const team of teams) {
      teamsProcessed++;
      try {
        // WATERMARK CONTIGUO, no `MAX(recordedAt)` (hallazgo 2.2 — el ratchet).
        // El rastro viene DESCENDENTE, así que una lectura parcial trae los puntos MÁS
        // NUEVOS. Derivar el watermark de lo persistido lo haría saltar POR ENCIMA del
        // hueco y la cola no se volvería a pedir nunca. Este watermark sólo avanza
        // cuando una lectura terminó COMPLETA.
        const state = await this.repo.getIngestState(team.login);
        const trail = await this.source.listTeamLocations(
          team.externalId,
          team.login,
          state?.contiguousWatermark ?? null,
        );

        pagesRead += trail.pagesRead;
        pointsDropped += trail.pointsDropped;

        // Lo que SÍ se leyó se persiste igual: descartarlo perdería dato que expira en
        // 30 días. Lo que no se hace es dar la lectura por completa.
        let newestPersisted: Date | null = null;
        if (trail.points.length > 0) {
          const saved = await this.repo.saveMany(trail.points);
          pointsNew += saved.inserted;
          pointsDuplicate += saved.duplicates;
          newestPersisted = trail.points.reduce<Date | null>(
            (max, p) => (!max || p.recordedAt > max ? p.recordedAt : max),
            null,
          );
        }

        if (trail.incomplete) {
          incompleteTeams.add(team.login);
          await this.repo.markTeamIncomplete(team.login, this.now());
        } else {
          await this.repo.markTeamComplete(team.login, newestPersisted);
        }
      } catch {
        // Una cuadrilla caída no puede tumbar la corrida entera — y tampoco puede
        // avanzar su watermark.
        incompleteTeams.add(team.login);
        try {
          await this.repo.markTeamIncomplete(team.login, this.now());
        } catch {
          // Si ni el marcado se puede persistir, no hay nada más que hacer por ésta.
        }
      }
    }

    // La purga NO puede abortar la corrida: si falla, se pierde la fila de
    // observabilidad de un ingest que sí persistió puntos.
    let pointsPurged = 0;
    try {
      pointsPurged = await this.repo.purgeOlderThan(this.retentionCutoff());
    } catch {
      pointsPurged = 0;
    }

    const summary: IngestRunSummary = {
      teamsProcessed,
      pointsNew,
      pointsDuplicate,
      pointsPurged,
      pagesRead,
      pointsDropped,
      incompleteTeams: [...incompleteTeams],
    };

    await this.repo.recordIngestRun({ ...summary, startedAt, finishedAt: this.now() });

    return summary;
  }

  /**
   * Corte de retención. `setUTCMonth` DESBORDA con meses cortos: restarle 1 mes al 31 de
   * marzo da "31 de febrero", que JS normaliza al 3 de marzo — un cutoff en el FUTURO
   * respecto del pretendido, que borra días que había que conservar (hallazgo 4.4).
   * El borrado es irreversible y IClass ya no tiene ese dato.
   */
  private retentionCutoff(): Date {
    const now = this.now();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() - this.retentionMonths;
    const day = now.getUTCDate();

    // Se acota el día al último día real del mes destino antes de construir la fecha.
    const targetYear = year + Math.floor(month / 12);
    const targetMonth = ((month % 12) + 12) % 12;
    const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

    return new Date(
      Date.UTC(
        targetYear,
        targetMonth,
        Math.min(day, lastDayOfTargetMonth),
        now.getUTCHours(),
        now.getUTCMinutes(),
        now.getUTCSeconds(),
      ),
    );
  }
}
