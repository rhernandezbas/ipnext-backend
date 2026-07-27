import type { TeamLocationRepository } from '@domain/ports/TeamLocationRepository';
import { haversineMeters } from '@domain/services/haversine';
import { formatIClassDateTime } from '@domain/services/iclassDateTime';

/**
 * Jornada de una cuadrilla en un día calendario ARGENTINO, derivada del rastro solo
 * (sin órdenes de servicio de por medio).
 *
 * ## Sobre la distancia recorrida — leer antes de usar el número
 *
 * `travelledMetersLowerBound` suma tramos RECTOS entre puntos consecutivos tomados cada
 * 5-10 minutos. Eso "corta las curvas" y por construcción **SUBESTIMA** el recorrido real.
 * Se expone como cota inferior explícita (`isLowerBound`) junto al intervalo de muestreo,
 * porque sobre esta cifra alguien podría evaluar el desempeño de una persona y presentarla
 * como exacta sería vender un número que no es.
 */

export interface TeamDailyJourney {
  teamLogin: string;
  argentinaDay: string;
  pointCount: number;
  firstPointAt: Date | null;
  lastPointAt: Date | null;
  /** Puntos por hora ARGENTINA ("06", "07", ...). */
  pointsByHour: Record<string, number>;
  /** Cota INFERIOR del recorrido, en metros. Nunca el valor exacto. */
  travelledMetersLowerBound: number;
  isLowerBound: true;
  /** Mediana del intervalo entre puntos, en minutos. `null` con menos de 2 puntos. */
  medianSamplingMinutes: number | null;
}

export interface GetTeamDailyJourneyDeps {
  repo: TeamLocationRepository;
}

export class GetTeamDailyJourney {
  private readonly repo: TeamLocationRepository;

  constructor(deps: GetTeamDailyJourneyDeps) {
    this.repo = deps.repo;
  }

  async execute(input: { teamLogin: string; argentinaDay: string }): Promise<TeamDailyJourney> {
    const points = await this.repo.findByTeamOnDay(input.teamLogin, input.argentinaDay);

    const base = {
      teamLogin: input.teamLogin,
      argentinaDay: input.argentinaDay,
      isLowerBound: true as const,
    };

    if (points.length === 0) {
      return {
        ...base,
        pointCount: 0,
        firstPointAt: null,
        lastPointAt: null,
        pointsByHour: {},
        travelledMetersLowerBound: 0,
        medianSamplingMinutes: null,
      };
    }

    const pointsByHour: Record<string, number> = {};
    for (const p of points) {
      // La hora se toma del formato argentino, no de getUTCHours(): en prod el proceso
      // corre en UTC y agruparía la jornada 3 horas corrida.
      const hour = formatIClassDateTime(p.recordedAt).slice(11, 13);
      pointsByHour[hour] = (pointsByHour[hour] ?? 0) + 1;
    }

    let travelled = 0;
    const gapsMinutes: number[] = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      travelled += haversineMeters(prev.latitude, prev.longitude, curr.latitude, curr.longitude);
      gapsMinutes.push((curr.recordedAt.getTime() - prev.recordedAt.getTime()) / 60_000);
    }

    return {
      ...base,
      pointCount: points.length,
      firstPointAt: points[0].recordedAt,
      lastPointAt: points[points.length - 1].recordedAt,
      pointsByHour,
      travelledMetersLowerBound: travelled,
      medianSamplingMinutes: median(gapsMinutes),
    };
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
