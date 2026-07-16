/**
 * AutoCureStuckSessions — UN tick del watcher de auto-curación de sesiones RADIUS colgadas
 * (radius-session-autocure BE-1, REQ-CURE-1 + REQ-CURE-4). Molde `AutoMovePppoe` (pppoe-move-nas
 * W2): detección → breaker → cap → (cure-throttle + flapping por candidato) → delega el resto
 * (gates + cura + registro) al core `CureStuckSession`.
 *
 * Pipeline por tick (D5 + D7):
 *   1. detección: RadiusAuthEvent reason='session_stuck' del lookback (port EXISTENTE,
 *      RadiusAuthIngestScheduler ya los ingirió — CERO queries nuevas contra el orchestrator).
 *   2. agregado por username: {firstReject, lastReject} — insumo del fast path del core.
 *   3. breaker: candidatos ÚNICOS > abortThreshold → ABORT del tick entero (incidente de NAS,
 *      no sesiones colgadas — cero llamadas al gateway).
 *   4. cap: a lo sumo maxPerTick candidatos; el resto → deferred (el evento sigue en el lookback).
 *   5. por candidato (aislamiento de fallos por ítem):
 *      a. cure-throttle 30min: último 'cured' del username más nuevo que cooldownMs → skip
 *         (counter `skippedCureThrottle`, SIN fila) — pesa MÁS que el fast path (S4.5).
 *      b. flapping: >= flappingMax eventos 'cured' del username en las últimas 24h (ventana FIJA)
 *         → fila `flagged_flapping` (throttle de registro 6h para repeticiones), CERO llamadas
 *         al cure.
 *      c-f. delega en `CureStuckSession.execute()` (gates FAIL-CLOSED + 2 caminos de cura +
 *         registro) y tallea el resultado en el summary.
 */
import type { RadiusAuthEventRepository } from '@domain/ports/RadiusAuthEventRepository';
import type { RadiusSessionCureEventRepository } from '@domain/ports/RadiusSessionCureEventRepository';
import { isDuplicateCureEvent } from '@application/services/radiusSessionCureThrottle';
import { CureStuckSession, RejectAggregate } from './CureStuckSession';

/** Ventana FIJA del check de flapping (documentada, NO configurable — D7). */
const FLAPPING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Tamaño de página del barrido de RadiusAuthEvent (molde OrchestratorRadiusSessionRepository). */
const PAGE_SIZE = 500;

export interface AutoCureStuckSessionsTuning {
  lookbackMs: number;
  abortThreshold: number;
  maxPerTick: number;
  /** Cure-throttle anti-flapping: una cura por username cada `cooldownMs` MÁXIMO. */
  cooldownMs: number;
  /** ≥ N curas del username en 24h ⇒ flagged_flapping. */
  flappingMax: number;
}

export interface AutoCureStuckSessionsSummary {
  /** Total de filas RadiusAuthEvent leídas del lookback (puede tener 179 rejects de UN username). */
  events: number;
  /** Usernames ÚNICOS detectados. */
  candidates: number;
  cured: number;
  alreadyCured: number;
  failed: number;
  skippedAlive: number;
  skippedAmbiguous: number;
  skippedNoSession: number;
  skippedNoSignal: number;
  /** Cure-throttle 30min: sin fila (S4.5). */
  skippedCureThrottle: number;
  flaggedFlapping: number;
  /** Candidatos que excedieron el cap del tick — se reintentan el próximo. */
  deferred: number;
  /** Filas suprimidas por el throttle de registro de 6h (skip/failed/flagged_flapping idénticos). */
  throttled: number;
  /** true si el tick se ABORTÓ entero (breaker) — cero curas, cero llamadas al gateway. */
  aborted: boolean;
}

export class AutoCureStuckSessions {
  private readonly now: () => Date;

  constructor(
    private readonly radiusAuthEventRepo: RadiusAuthEventRepository,
    private readonly cureEventRepo: RadiusSessionCureEventRepository,
    private readonly cureStuckSession: CureStuckSession,
    private readonly tuning: AutoCureStuckSessionsTuning,
    opts?: { now?: () => Date },
  ) {
    this.now = opts?.now ?? (() => new Date());
  }

  async run(): Promise<AutoCureStuckSessionsSummary> {
    const now = this.now();
    const summary: AutoCureStuckSessionsSummary = {
      events: 0, candidates: 0, cured: 0, alreadyCured: 0, failed: 0,
      skippedAlive: 0, skippedAmbiguous: 0, skippedNoSession: 0, skippedNoSignal: 0,
      skippedCureThrottle: 0, flaggedFlapping: 0, deferred: 0, throttled: 0, aborted: false,
    };

    const from = new Date(now.getTime() - this.tuning.lookbackMs);
    const { total, byUser } = await this.fetchAggregates(from);
    summary.events = total;
    summary.candidates = byUser.size;

    if (byUser.size === 0) return summary;

    // ── Breaker (D7): decenas de stuck simultáneos = incidente de NAS, no sesión colgada. ──
    if (byUser.size > this.tuning.abortThreshold) {
      summary.aborted = true;
      console.warn(
        `[radius-auto-cure] tick ABORTADO: ${byUser.size} candidatos > umbral ${this.tuning.abortThreshold} ` +
        `(huele a incidente de NAS masivo). CERO curas ejecutadas.`,
      );
      return summary;
    }

    let processed = 0;
    for (const [username, aggregate] of byUser) {
      if (processed >= this.tuning.maxPerTick) {
        summary.deferred++;
        continue;
      }
      processed++;
      try {
        await this.processCandidate(username, aggregate, now, summary);
      } catch (err) {
        // Aislamiento por ítem (S4.7): un fallo NO aborta el tick.
        summary.failed++;
        console.warn(`[radius-auto-cure] candidato '${username}' FALLÓ (aislado):`, err instanceof Error ? err.message : err);
      }
    }

    return summary;
  }

  private async processCandidate(
    username: string,
    aggregate: RejectAggregate,
    now: Date,
    summary: AutoCureStuckSessionsSummary,
  ): Promise<void> {
    // a. Cure-throttle 30min (S4.5): pesa MÁS que el fast path — se chequea ANTES de todo.
    const { items: lastCured } = await this.cureEventRepo.list({
      page: 1, limit: 1, usernameExact: username, outcome: 'cured',
    });
    const last = lastCured[0];
    if (last && now.getTime() - Date.parse(last.createdAt) < this.tuning.cooldownMs) {
      summary.skippedCureThrottle++;
      return;
    }

    // b. Flapping (S4.6): >= flappingMax curas en las últimas 24h (ventana FIJA).
    const flappingSince = new Date(now.getTime() - FLAPPING_WINDOW_MS);
    const { total: recentCuresCount } = await this.cureEventRepo.list({
      page: 1, limit: this.tuning.flappingMax, usernameExact: username, outcome: 'cured', from: flappingSince,
    });
    if (recentCuresCount >= this.tuning.flappingMax) {
      const reason = `${recentCuresCount}_cures_in_24h`;
      const duplicate = await isDuplicateCureEvent(this.cureEventRepo, username, 'flagged_flapping', reason, now.getTime());
      if (duplicate) {
        summary.throttled++;
      } else {
        await this.cureEventRepo.record({ username, trigger: 'auto', outcome: 'flagged_flapping', reason, actorName: 'sistema' });
        summary.flaggedFlapping++;
      }
      return;
    }

    // c-f. Gates FAIL-CLOSED + 2 caminos de cura + registro — delegado al core compartido.
    const result = await this.cureStuckSession.execute({
      username, trigger: 'auto', actorName: 'sistema', now, rejectAggregate: aggregate,
    });
    this.tally(result, summary);
  }

  private tally(
    result: Awaited<ReturnType<CureStuckSession['execute']>>,
    summary: AutoCureStuckSessionsSummary,
  ): void {
    if (result.registrationThrottled) {
      summary.throttled++;
      return;
    }
    switch (result.outcome) {
      case 'cured':              summary.cured++; break;
      case 'already_cured':      summary.alreadyCured++; break;
      case 'skipped_alive':      summary.skippedAlive++; break;
      case 'skipped_ambiguous':  summary.skippedAmbiguous++; break;
      case 'skipped_no_session': summary.skippedNoSession++; break;
      case 'skipped_no_signal':  summary.skippedNoSignal++; break;
      case 'failed':             summary.failed++; break;
      case 'flagged_flapping':   summary.flaggedFlapping++; break; // no debería llegar acá (se maneja arriba); defensivo
    }
  }

  /** Barre TODAS las páginas de RadiusAuthEvent reason='session_stuck' desde `from`. */
  private async fetchAggregates(from: Date): Promise<{ total: number; byUser: Map<string, RejectAggregate> }> {
    const byUser = new Map<string, RejectAggregate>();
    let page = 1;
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const result = await this.radiusAuthEventRepo.list({ reason: 'session_stuck', from, page, pageSize: PAGE_SIZE });
      total = result.total;
      for (const ev of result.data) {
        const at = new Date(ev.authdate);
        const existing = byUser.get(ev.username);
        if (!existing) {
          byUser.set(ev.username, { firstReject: at, lastReject: at });
        } else {
          if (at.getTime() < existing.firstReject.getTime()) existing.firstReject = at;
          if (at.getTime() > existing.lastReject.getTime()) existing.lastReject = at;
        }
      }
      if (result.data.length < PAGE_SIZE) break;
      page++;
    }
    return { total, byUser };
  }
}
