import type { TeamLocationPoint, TimeWindow } from '../entities/team-location-point';

/**
 * Persistencia propia de los breadcrumbs GPS de las cuadrillas.
 *
 * Existe porque IClass retiene el rastro sólo ~30 días rolling (verificado): sin una copia
 * propia no hay auditoría histórica posible, el dato se pierde solo.
 */

/** Punto listo para persistir (aún sin id de base). */
export type NewTeamLocationPoint = TeamLocationPoint;

export interface IngestRunSummary {
  teamsProcessed: number;
  pointsNew: number;
  pointsDuplicate: number;
  pointsPurged: number;
  pagesRead: number;
  /**
   * Puntos que IClass devolvió pero no se pudieron leer (timestamp/coordenadas
   * inválidos, fecha futura). Un salto acá delata un cambio de contrato de la API,
   * que de otro modo se vería como una corrida exitosa con cero datos.
   */
  pointsDropped: number;
  /** Cuadrillas cuyo rastro NO pudo leerse completo. Nunca se cuentan como exitosas. */
  incompleteTeams: string[];
}

/**
 * Estado del ingest de UNA cuadrilla. Rompe el ratchet del watermark: mientras haya un
 * hueco pendiente, el watermark de lectura NO avanza.
 */
export interface TeamIngestState {
  teamLogin: string;
  /** Hasta acá el rastro está leído sin huecos. `null` = nunca se completó una lectura. */
  contiguousWatermark: Date | null;
  lastIncompleteAt: Date | null;
  consecutiveIncomplete: number;
}

export interface TeamLocationRepository {
  /**
   * Persiste puntos deduplicando por `(teamLogin, recordedAt, latitude, longitude)`.
   * El `origem` queda FUERA de la clave a propósito: IClass emite el mismo fix físico
   * por dos fuentes distintas y son el mismo punto.
   *
   * Debe ser IDEMPOTENTE: reingestar la misma ventana no duplica filas.
   *
   * @returns cuántos puntos se insertaron y cuántos se descartaron por duplicados.
   */
  saveMany(points: NewTeamLocationPoint[]): Promise<{ inserted: number; duplicates: number }>;

  /** Puntos de una cuadrilla dentro de una ventana, ordenados cronológicamente. */
  findByTeamInWindow(teamLogin: string, window: TimeWindow): Promise<TeamLocationPoint[]>;

  /** Último punto conocido de cada cuadrilla (para el mapa en vivo). */
  findLatestPerTeam(): Promise<TeamLocationPoint[]>;

  /**
   * Instante del punto más reciente ya persistido para una cuadrilla — el watermark que
   * permite al ingest cortar cuando alcanzó lo que ya tiene, sin recorrer todo el rastro.
   */
  findWatermark(teamLogin: string): Promise<Date | null>;

  /** Puntos de una cuadrilla en un día calendario argentino ("yyyy-MM-dd"). */
  findByTeamOnDay(teamLogin: string, argentinaDay: string): Promise<TeamLocationPoint[]>;

  /** Borra los puntos anteriores al corte de retención. @returns cuántos borró. */
  purgeOlderThan(cutoff: Date): Promise<number>;

  /** Estado de ingest de una cuadrilla. `null` si nunca se ingestó. */
  getIngestState(teamLogin: string): Promise<TeamIngestState | null>;

  /**
   * Marca la lectura de una cuadrilla como COMPLETA y avanza su watermark contiguo.
   * Sólo se llama cuando NO hubo hueco.
   */
  markTeamComplete(teamLogin: string, watermark: Date | null): Promise<void>;

  /**
   * Marca la lectura como INCOMPLETA: el watermark contiguo NO se mueve, así que la
   * corrida siguiente vuelve a pedir desde antes del hueco.
   */
  markTeamIncomplete(teamLogin: string, at: Date): Promise<void>;

  /** Registra el resumen de una corrida de ingest (observabilidad). */
  recordIngestRun(summary: IngestRunSummary & { startedAt: Date; finishedAt: Date }): Promise<void>;
}
