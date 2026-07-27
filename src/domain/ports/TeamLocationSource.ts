import type { TeamLocationPoint } from '../entities/team-location-point';

/**
 * Fuente externa del rastro de cuadrillas. La implementa el adapter de IClass.
 *
 * El dominio depende de ESTA interfaz, nunca del `IClassClient` concreto (DIP). Así el
 * día que la fuente cambie —u otro FSM reemplace a IClass— el núcleo no se toca.
 */

export interface TeamDescriptor {
  /** Clave de negocio estable. El campo `id` de IClass llega `null` en el listado. */
  login: string;
  name: string;
  /** Id interno de IClass, extraído del path embebido en `localizacoes`. */
  externalId: string;
  /** Estado administrativo. NO determina si la cuadrilla trackea. */
  status: string | null;
}

export interface TeamTrailPage {
  points: TeamLocationPoint[];
  pagesRead: number;
  /**
   * `true` cuando el rastro NO pudo leerse completo: `429` persistentes, rate-limit
   * textual de IClass, tope de páginas agotado, o una página entera ilegible.
   *
   * El consumidor DEBE tratar esto como "hay un hueco" y NO avanzar su watermark:
   * el modo de falla peligroso de este ingest es el silencioso.
   */
  incomplete: boolean;
  /**
   * Puntos descartados por ilegibles (timestamp o coordenadas inválidas, fecha futura).
   *
   * Sin este contador, un cambio de formato en IClass produce `new=0` con `incomplete:[]`
   * — éxito perfecto sobre cero datos. Es lo ÚNICO que delata ese escenario.
   */
  pointsDropped: number;
}

export interface TeamLocationSource {
  /** Catálogo de cuadrillas con su id externo ya resuelto. */
  listTeams(): Promise<TeamDescriptor[]>;

  /**
   * Rastro de una cuadrilla, paginado de forma robusta.
   *
   * La implementación NO DEBE cortar ante una página con menos ítems que el `pagesize`
   * (medido: cortar ahí trajo 2.600 de 6.286 puntos, 59% perdido en silencio) ni confiar
   * en `hasMoreElements`/`totalpages`/`totalobjects`, que IClass omite de forma
   * inconsistente. Corta sólo tras dos páginas vacías o `204` consecutivas.
   *
   * @param stopAtOrBefore watermark opcional: deja de paginar al alcanzar puntos que ya
   *        se tienen persistidos (el rastro viene ordenado por fecha DESCENDENTE).
   */
  listTeamLocations(
    externalId: string,
    teamLogin: string,
    stopAtOrBefore?: Date | null,
  ): Promise<TeamTrailPage>;

  /** Última posición conocida. Devuelve `null` ante `204` (cuadrilla sin rastro). */
  getLastTeamLocation(login: string): Promise<TeamLocationPoint | null>;
}
