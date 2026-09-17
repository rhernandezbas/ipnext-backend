import { mapsUrlFor } from '@domain/entities/team-location-point';
import type { TeamLocationPoint } from '@domain/entities/team-location-point';
import type { TeamLocationRepository } from '@domain/ports/TeamLocationRepository';
import type { TeamLocationSource } from '@domain/ports/TeamLocationSource';

/**
 * Estado en vivo de las cuadrillas, para despacho operativo.
 *
 * Pregunta a IClass la última posición de cada cuadrilla (`/teams/lastlocation`, una
 * llamada barata por cuadrilla) y cae al último punto persistido cuando IClass no
 * responde por esa cuadrilla: el ingest histórico corre cada 6 h y puede estar apagado,
 * así que depender sólo de él dibuja un mapa vacío o viejo. La frescura sigue siendo
 * parte del contrato: una posición de hace dos días nunca se rotula como actual.
 */

/** A partir de acá el dato deja de considerarse actual. */
const STALE_AFTER_MINUTES = 24 * 60;
/** Ventana en la que varias aperturas del mapa reusan la misma lectura. */
const LIVE_CACHE_SECONDS = 90;
/** Llamadas simultáneas a IClass — su rate limit es agresivo. */
const LIVE_CONCURRENCY = 4;
/** Tope de tiempo de la lectura: pasado esto se sirve lo persistido en vez de hacer esperar. */
const LIVE_BUDGET_SECONDS = 8;
/** Espera mínima tras una lectura sin resultados: IClass suele estar pidiendo aire. */
const LIVE_RETRY_SECONDS = 15;

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
  liveCacheSeconds?: number;
  liveBudgetSeconds?: number;
  liveConcurrency?: number;
  liveRetrySeconds?: number;
}

export class GetTeamsLiveStatus {
  private readonly repo: TeamLocationRepository;
  private readonly source: TeamLocationSource;
  private readonly now: () => Date;
  private readonly staleAfterMinutes: number;
  private readonly liveCacheSeconds: number;
  private readonly liveBudgetSeconds: number;
  private readonly liveConcurrency: number;
  private readonly liveRetrySeconds: number;
  /** `covered` son las cuadrillas que IClass respondió (con o sin punto), no las pedidas. */
  private liveCache: { readAt: number; covered: Set<string>; points: Map<string, TeamLocationPoint> } | null = null;
  /** Lectura en curso: varias aperturas simultáneas del mapa comparten una sola. */
  private inFlight: { logins: Set<string>; result: Promise<Map<string, TeamLocationPoint>> } | null = null;
  /** Hasta cuándo no se vuelve a molestar a IClass tras una lectura sin resultados. */
  private retryAfter = 0;

  constructor(deps: GetTeamsLiveStatusDeps) {
    this.repo = deps.repo;
    this.source = deps.source;
    this.now = deps.now ?? (() => new Date());
    this.staleAfterMinutes = deps.staleAfterMinutes ?? STALE_AFTER_MINUTES;
    this.liveCacheSeconds = deps.liveCacheSeconds ?? LIVE_CACHE_SECONDS;
    this.liveBudgetSeconds = deps.liveBudgetSeconds ?? LIVE_BUDGET_SECONDS;
    this.liveConcurrency = deps.liveConcurrency ?? LIVE_CONCURRENCY;
    this.liveRetrySeconds = deps.liveRetrySeconds ?? LIVE_RETRY_SECONDS;
  }

  async execute(): Promise<TeamLiveStatus[]> {
    const [teams, latest] = await Promise.all([
      this.source.listTeams(),
      this.repo.findLatestPerTeam(),
    ]);

    const byLogin = new Map(latest.map((p) => [p.teamLogin, p]));
    for (const [login, live] of await this.livePositions(teams.map((t) => t.login))) {
      // Se queda el MÁS RECIENTE: el rastro persistido puede venir de una lectura posterior.
      const stored = byLogin.get(login);
      if (!stored || live.recordedAt.getTime() > stored.recordedAt.getTime()) byLogin.set(login, live);
    }
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

  /**
   * Última posición de cada cuadrilla según IClass. Una cuadrilla que falla o no reporta
   * simplemente no entra: el llamador ya tiene su punto persistido como respaldo.
   */
  private async livePositions(logins: string[]): Promise<Map<string, TeamLocationPoint>> {
    const cache = this.liveCache;
    // Presupuesto 0 = lectura en vivo apagada por configuración: ni se consulta a IClass ni
    // se la acusa de no responder en cada request.
    if (this.liveBudgetSeconds <= 0 || logins.length === 0) return cache?.points ?? new Map();
    const nowMs = this.nowMs();
    const fresh = cache !== null && nowMs - cache.readAt < this.liveCacheSeconds * 1000;
    // Se releen SÓLO las cuadrillas que el cache no cubre (falló, se cortó por presupuesto
    // o entró al roster después): releer el resto amplifica la carga sobre IClass.
    const missing = cache && fresh ? logins.filter((login) => !cache.covered.has(login)) : logins;
    if (cache && missing.length === 0) return cache.points;
    if (nowMs < this.retryAfter) return cache?.points ?? new Map();

    // Una sola lectura en curso: si no, cada apertura simultánea del mapa dispara la suya.
    const running = this.inFlight;
    if (running && missing.every((login) => running.logins.has(login))) return running.result;

    const result = this.readLivePositions(missing).finally(() => {
      if (this.inFlight?.result === result) this.inFlight = null;
    });
    this.inFlight = { logins: new Set(missing), result };
    return result;
  }

  private async readLivePositions(logins: string[]): Promise<Map<string, TeamLocationPoint>> {
    const deadline = this.nowMs() + this.liveBudgetSeconds * 1000;
    const live = new Map<string, TeamLocationPoint>();
    const answered = new Set<string>();
    const pending = [...logins];
    let expired = false;
    const workers = Array.from({ length: Math.min(this.liveConcurrency, pending.length) }, async () => {
      for (let login = pending.shift(); login !== undefined; login = pending.shift()) {
        if (expired || this.elapsed(deadline)) return;
        try {
          const point = await this.source.getLastTeamLocation(login);
          if (expired) return; // la respuesta llegó tarde: ya se sirvió el mapa sin ella
          answered.add(login); // respondió: con punto, o sin rastro
          if (point) live.set(login, point);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn(`[teams-live] ${login}: IClass no devolvió la última posición:`, error);
        }
      }
    });
    // El chequeo previo a cada llamada no interrumpe la que ya está en curso, así que el
    // presupuesto se aplica también acá: la respuesta no espera más que eso.
    const budget = this.afterBudget();
    await Promise.race([Promise.all(workers).finally(() => budget.cancel()), budget.expired]);
    expired = true;

    // El cache se lee ACÁ, no al empezar: otra lectura pudo sellar mientras tanto.
    const carried = this.liveCache;
    const carriedFresh = carried !== null && this.nowMs() - carried.readAt < this.liveCacheSeconds * 1000;
    // Copias: lo que siga llegando de una llamada en vuelo no puede mutar lo ya servido.
    const points = new Map(carriedFresh ? [...carried!.points, ...live] : live);
    const covered = new Set(carriedFresh ? [...carried!.covered, ...answered] : answered);

    if (answered.size === 0) {
      // Nada leído. Sellar una lectura vacía congelaría el mapa toda la ventana; no sellar
      // nada hostiga a IClass en cada refresco. Se espera un rato corto y se reintenta.
      this.retryAfter = this.nowMs() + this.liveRetrySeconds * 1000;
      if (logins.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[teams-live] IClass no respondió por ninguna de las ${logins.length} cuadrillas`);
      }
      return this.liveCache?.points ?? points;
    }

    // El rastro propio es la única copia que sobrevive a la retención de ~30 días de IClass.
    try {
      if (live.size > 0) await this.repo.saveMany([...live.values()]);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[teams-live] no se pudieron persistir las posiciones leídas:', error);
    }

    // La ventana arranca en la lectura ORIGINAL: releer una cuadrilla no puede extendérsela
    // a las demás, que si no quedarían servidas el doble de tiempo del configurado.
    this.liveCache = { readAt: carriedFresh ? carried!.readAt : this.nowMs(), covered, points };
    return points;
  }

  /** Reloj a prueba de fallos: un reloj roto nunca debe tumbar el mapa. */
  private nowMs(): number {
    try {
      return this.now().getTime();
    } catch {
      return Date.now();
    }
  }

  private elapsed(deadline: number): boolean {
    return this.nowMs() >= deadline;
  }

  private afterBudget(): { expired: Promise<void>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.liveBudgetSeconds * 1000);
      if (timer.unref) timer.unref();
    });
    return { expired, cancel: () => clearTimeout(timer) };
  }
}
