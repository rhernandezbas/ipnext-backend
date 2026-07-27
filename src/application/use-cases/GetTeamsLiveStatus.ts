import { mapsUrlFor } from '@domain/entities/team-location-point';
import type { TeamLocationRepository } from '@domain/ports/TeamLocationRepository';
import type { TeamLocationSource } from '@domain/ports/TeamLocationSource';

/**
 * Estado en vivo de las cuadrillas, para despacho operativo.
 *
 * Sirve el ÚLTIMO PUNTO PERSISTIDO, no consulta IClass por request (rate limit). Por eso
 * la frescura del dato es parte del contrato: una posición de hace dos días dibujada como
 * "actual" induce a un error de despacho.
 */

/** A partir de acá el dato deja de considerarse actual. */
const STALE_AFTER_MINUTES = 24 * 60;

export type TeamLiveState =
  /** Reportó dentro de la ventana de frescura. */
  | 'ACTIVA'
  /** Tiene rastro, pero viejo. Se muestra rotulada, nunca como posición actual. */
  | 'DESACTUALIZADA'
  /** Nunca reportó (típicamente un login cancelado o duplicado). */
  | 'SIN_RASTRO';

export interface TeamLiveStatus {
  login: string;
  name: string;
  /** Estado administrativo en IClass. NO determina si la cuadrilla trackea. */
  iclassStatus: string | null;
  state: TeamLiveState;
  latitude: number | null;
  longitude: number | null;
  lastPointAt: Date | null;
  accuracyMeters: number | null;
  minutesSinceLastPoint: number | null;
  mapsUrl: string | null;
}

export interface GetTeamsLiveStatusDeps {
  repo: TeamLocationRepository;
  source: TeamLocationSource;
  now?: () => Date;
  staleAfterMinutes?: number;
}

export class GetTeamsLiveStatus {
  private readonly repo: TeamLocationRepository;
  private readonly source: TeamLocationSource;
  private readonly now: () => Date;
  private readonly staleAfterMinutes: number;

  constructor(deps: GetTeamsLiveStatusDeps) {
    this.repo = deps.repo;
    this.source = deps.source;
    this.now = deps.now ?? (() => new Date());
    this.staleAfterMinutes = deps.staleAfterMinutes ?? STALE_AFTER_MINUTES;
  }

  async execute(): Promise<TeamLiveStatus[]> {
    const [teams, latest] = await Promise.all([
      this.source.listTeams(),
      this.repo.findLatestPerTeam(),
    ]);

    const byLogin = new Map(latest.map((p) => [p.teamLogin, p]));
    const now = this.now().getTime();

    // Se lista el ROSTER completo: una cuadrilla sin rastro es información, no un hueco.
    return teams.map((team) => {
      const point = byLogin.get(team.login);
      if (!point) {
        return {
          login: team.login,
          name: team.name,
          iclassStatus: team.status,
          state: 'SIN_RASTRO' as const,
          latitude: null,
          longitude: null,
          lastPointAt: null,
          accuracyMeters: null,
          minutesSinceLastPoint: null,
          mapsUrl: null,
        };
      }

      const minutes = (now - point.recordedAt.getTime()) / 60_000;
      return {
        login: team.login,
        name: team.name,
        iclassStatus: team.status,
        // El estado de IClass NO entra en esta decisión: se observó una cuadrilla
        // "Inativo" reportando puntos el mismo día.
        state: minutes > this.staleAfterMinutes ? ('DESACTUALIZADA' as const) : ('ACTIVA' as const),
        latitude: point.latitude,
        longitude: point.longitude,
        lastPointAt: point.recordedAt,
        accuracyMeters: point.accuracyMeters,
        minutesSinceLastPoint: minutes,
        mapsUrl: mapsUrlFor(point.latitude, point.longitude),
      };
    });
  }
}
