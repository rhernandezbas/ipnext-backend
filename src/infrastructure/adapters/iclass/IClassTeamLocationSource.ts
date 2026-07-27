import type { TeamLocationPoint } from '@domain/entities/team-location-point';
import type {
  TeamDescriptor,
  TeamLocationSource,
  TeamTrailPage,
} from '@domain/ports/TeamLocationSource';
import type { IClassClient } from './IClassClient';

/**
 * Implementa `TeamLocationSource` delegando en el `IClassClient`.
 *
 * Existe como clase aparte —y no como `implements` sobre IClassClient— porque el cliente
 * YA tiene un `listTeams()` con otra firma (devuelve `IClassTeamDescriptor[]`, sin el id
 * interno). Cambiarle el tipo de retorno rompería a sus consumidores actuales en
 * producción; este wrapper adapta sin tocar nada de lo existente.
 *
 * Además deja la superficie que ve el dominio estrictamente de LECTURA: el `IClassClient`
 * tiene métodos de escritura en prod (`closeServiceOrder`, `updateServiceOrder`) y la
 * auditoría no debe poder alcanzarlos ni por accidente.
 */
/** TTL del catálogo de cuadrillas. Cambia poquísimo (11 logins hoy). */
const TEAMS_CACHE_TTL_MS = 5 * 60 * 1000;

export class IClassTeamLocationSource implements TeamLocationSource {
  private teamsCache: { teams: TeamDescriptor[]; expiresAt: number } | null = null;

  constructor(
    private readonly client: IClassClient,
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = TEAMS_CACHE_TTL_MS,
  ) {}

  /**
   * Catálogo de cuadrillas, CACHEADO (hallazgo 2.11).
   *
   * `GetTeamsLiveStatus` lo llama en CADA request del mapa en vivo. Sin cache, un
   * dashboard poleando + el ingest (~770 GETs en el primer run) + el closure loop
   * garantizan el "Espere um pouco" de IClass — y ahí se dispara todo lo demás.
   * El catálogo cambia poquísimo: 5 minutos de TTL es de sobra.
   */
  async listTeams(): Promise<TeamDescriptor[]> {
    const nowMs = this.now();
    if (this.teamsCache && this.teamsCache.expiresAt > nowMs) return this.teamsCache.teams;

    const teams = await this.client.listTeamLocationDescriptors();
    // Sólo se cachea un resultado NO vacío: un roster vacío por un fallo transitorio no
    // debe quedar congelado 5 minutos haciendo desaparecer a todas las cuadrillas.
    if (teams.length > 0) this.teamsCache = { teams, expiresAt: nowMs + this.ttlMs };
    return teams;
  }

  listTeamLocations(
    externalId: string,
    teamLogin: string,
    stopAtOrBefore?: Date | null,
  ): Promise<TeamTrailPage> {
    return this.client.listTeamLocations(externalId, teamLogin, stopAtOrBefore);
  }

  getLastTeamLocation(login: string): Promise<TeamLocationPoint | null> {
    return this.client.getLastTeamLocation(login);
  }
}
