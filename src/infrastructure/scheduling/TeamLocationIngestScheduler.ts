import type { IngestTeamLocations } from '@application/use-cases/IngestTeamLocations';
import type { IngestRunSummary } from '@domain/ports/TeamLocationRepository';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { DistributedLock } from '@domain/ports/DistributedLock';

/**
 * Scheduler in-process del ingest de breadcrumbs GPS (change `iclass-gps-audit`).
 *
 * Espeja `IClassClosureScheduler`: inFlight + DistributedLock + intervalo fijo, errores
 * tragados, y re-lectura del feature flag en CADA tick para poder apagarlo sin redeploy.
 * Arranca dormido (el flag no existe → OFF).
 *
 * ## Cadencia
 *
 * Cada 6 horas. IClass retiene ~30 días, así que incluso 4 corridas fallidas seguidas
 * dejan un margen enorme antes de perder dato. Más frecuente sería gastar rate limit sin
 * ganancia: los breadcrumbs llegan cada 5-10 minutos y esto no es tiempo real (el mapa
 * en vivo sirve el último punto YA persistido, no consulta IClass por request).
 */

/** Feature flag que gatea el ingest. Default OFF hasta el go-live. */
const FLAG_KEY = 'iclass-gps-ingest';
/** Advisory lock — distinto de 'iclass-closed' y de los locks de GR. */
const LOCK_KEY = 'team-locations';

/** 6 horas. */
export const DEFAULT_INGEST_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface TeamLocationIngestSchedulerOptions {
  intervalMs: number;
  silent?: boolean;
}

export interface TeamLocationIngestRunResult {
  skipped?: boolean;
  error?: string;
  summary?: IngestRunSummary;
}

export class TeamLocationIngestScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;

  constructor(
    private readonly ingest: IngestTeamLocations,
    private readonly flags: FeatureFlagRepository,
    private readonly opts: TeamLocationIngestSchedulerOptions,
    private readonly lock: DistributedLock,
  ) {}

  start(): void {
    this.log(`[gps-ingest] started, interval=${this.opts.intervalMs}ms`);
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    // unref: el scheduler nunca debe impedir que el proceso termine.
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.log('[gps-ingest] stopped');
  }

  async runOnce(): Promise<TeamLocationIngestRunResult> {
    if (this.inFlight) {
      this.log('[gps-ingest] skipped — previous run still in flight');
      return { skipped: true };
    }

    // `flags.get` y `lock.tryAcquire` van DENTRO del try (hallazgo 2.10): antes estaban
    // afuera, y como los callers invocan `void this.runOnce()`, un parpadeo del pool de
    // PG producía un unhandled rejection — que en Node >= 15 mata el proceso.
    let acquired = false;
    try {
      const flag = await this.flags.get(FLAG_KEY);
      if (!flag?.enabled) {
        this.log('[gps-ingest] skipped — flag off');
        return { skipped: true };
      }

      acquired = await this.lock.tryAcquire(LOCK_KEY);
      if (!acquired) {
        this.log('[gps-ingest] skipped — lock held by another instance');
        return { skipped: true };
      }
    } catch (err) {
      const message = (err as Error).message;
      this.log(`[gps-ingest] ERROR resolviendo flag/lock: ${message}`);
      return { error: message };
    }

    this.inFlight = true;
    try {
      const summary = await this.ingest.execute();
      // El log lista SIEMPRE las cuadrillas incompletas: el modo de falla peligroso de
      // este ingest es el silencioso — traer de menos y parecer exitoso.
      this.log(
        `[gps-ingest] teams=${summary.teamsProcessed} new=${summary.pointsNew} ` +
          `dup=${summary.pointsDuplicate} purged=${summary.pointsPurged} ` +
          `pages=${summary.pagesRead} incomplete=[${summary.incompleteTeams.join(',')}]`,
      );
      return { summary };
    } catch (err) {
      const message = (err as Error).message;
      this.log(`[gps-ingest] ERROR: ${message}`);
      return { error: message };
    } finally {
      this.inFlight = false;
      try {
        // Un release que rechaza sobre una conexión rota NO puede pisar el `return` de
        // una corrida exitosa con un unhandled rejection.
        await this.lock.release(LOCK_KEY);
      } catch (releaseErr) {
        this.log(`[gps-ingest] no se pudo liberar el lock: ${(releaseErr as Error).message}`);
      }
    }
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(msg);
  }
}
