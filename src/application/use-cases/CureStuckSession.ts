/**
 * CureStuckSession — core de auto-curación de sesiones RADIUS colgadas (radius-session-autocure
 * BE-1, REQ-CURE-2/3/5/6). Compartido por el watcher `AutoCureStuckSessions` (trigger 'auto') y
 * la ruta manual `POST /api/radius/session-cures` (trigger 'manual').
 *
 * Gates FAIL-CLOSED (REQ-CURE-2), EN ORDEN:
 *   (a) 0 sesiones abiertas                      → skipped_no_session
 *   (b) sesiones abiertas en NAS DISTINTOS        → skipped_ambiguous (force manual lo saltea)
 *   (c) alguna sesión SIN lastUpdate en el wire   → skipped_no_signal (NUNCA se saltea)
 *   (d) FAST PATH (solo 'auto' + rejectAggregate): persistencia >= PERSISTENCE_MS Y
 *       recencia <= RECENCY_MS → cura TODAS las sesiones abiertas, signalUsed='persistent_rejects'
 *   (e) sin persistencia + ALGUNA sesión fresca   → skipped_alive (force manual lo saltea)
 *   (f) TODAS stale                                → cura, signalUsed='stale_interim' (solo 'auto';
 *       el manual NO etiqueta signal — el operador ES la evidencia, REQ-CURE-6)
 *
 * Multi-sesión (S2.8): sesiones que sobreviven los gates comparten el MISMO NAS por construcción
 * (el gate ambiguous ya filtró NAS distintos) — cada una recibe su propia llamada cureSession()
 * y su propia fila.
 *
 * Registro (REQ-CURE-5): TODO intento persiste una fila, EXCEPTO cuando el throttle de registro
 * de 6h (REQ-CURE-4(e)) suprime un skip/failed IDÉNTICO — y eso SOLO aplica a trigger 'auto'
 * (el manual SIEMPRE registra, REQ-CURE-6). `cured`/`already_cured` SIEMPRE registran.
 */
import type { OrchestratorSession, RadiusOrchestratorGateway, CoAResult } from '@domain/ports/RadiusOrchestratorGateway';
import type {
  RadiusSessionCureAction,
  RadiusSessionCureEvent,
  RadiusSessionCureEventRepository,
  RadiusSessionCureOutcome,
  RadiusSessionCureSignal,
  RadiusSessionCureTrigger,
} from '@domain/ports/RadiusSessionCureEventRepository';
import { OrchestratorRejectedError, OrchestratorUnreachableError } from '@domain/errors/pppoe';
import { isDuplicateCureEvent } from '@application/services/radiusSessionCureThrottle';

export interface CureStuckSessionTuning {
  /** Piso duro 20 min — lo aplica config.ts (parseIntervalMs), no este use case. */
  staleMs: number;
  persistenceMs: number;
  recencyMs: number;
}

export interface RejectAggregate {
  firstReject: Date;
  lastReject: Date;
}

export interface CureStuckSessionInput {
  username: string;
  trigger: RadiusSessionCureTrigger;
  actorName: string;
  /** Solo 'auto': agregado {firstReject, lastReject} de rejects session_stuck del tick. */
  rejectAggregate?: RejectAggregate | null;
  /** Solo 'manual': target UNA sesión puntual. Ausente → evalúa TODAS las sesiones abiertas. */
  sessionId?: string;
  /** Solo 'manual': saltea los gates alive/ambiguous (NUNCA no_session/no_signal). */
  force?: boolean;
  now?: Date;
}

export interface CureStuckSessionResult {
  /** Outcome dominante del intento. */
  outcome: RadiusSessionCureOutcome;
  reason: string | null;
  /** Filas EFECTIVAMENTE persistidas (0 si el throttle de registro auto-only suprimió la fila). */
  events: RadiusSessionCureEvent[];
  /** true si el throttle de registro de 6h (solo 'auto', outcome != 'cured') suprimió la fila. */
  registrationThrottled: boolean;
}

export class CureStuckSession {
  constructor(
    private readonly gateway: RadiusOrchestratorGateway,
    private readonly cureEventRepo: RadiusSessionCureEventRepository,
    private readonly tuning: CureStuckSessionTuning,
  ) {}

  async execute(input: CureStuckSessionInput): Promise<CureStuckSessionResult> {
    const now = input.now ?? new Date();
    try {
      let sessions = await this.gateway.listSessions(input.username);
      if (input.sessionId) {
        sessions = sessions.filter((s) => s.sessionId === input.sessionId);
      }

      if (sessions.length === 0) {
        return await this.finishSkip(input, 'skipped_no_session', 'no_open_sessions');
      }

      // Solo el manual con force explícito saltea alive/ambiguous (REQ-CURE-6). no_session y
      // no_signal NUNCA se saltean, ni con force.
      const bypassGates = input.trigger === 'manual' && input.force === true;

      const distinctNas = new Set(sessions.map((s) => s.nasIp));
      if (distinctNas.size > 1 && !bypassGates) {
        const reason = `sessions_on_multiple_nas:${[...distinctNas].sort().join(',')}`;
        return await this.finishSkip(input, 'skipped_ambiguous', reason);
      }

      const missingSignal = sessions.some((s) => (s.lastUpdate ?? null) === null);
      if (missingSignal) {
        return await this.finishSkip(input, 'skipped_no_signal', 'session_missing_last_update');
      }

      let signalUsed: RadiusSessionCureSignal | null = null;

      const fastPathEligible =
        input.trigger === 'auto' &&
        !!input.rejectAggregate &&
        input.rejectAggregate.lastReject.getTime() - input.rejectAggregate.firstReject.getTime() >= this.tuning.persistenceMs &&
        now.getTime() - input.rejectAggregate.lastReject.getTime() <= this.tuning.recencyMs;

      if (fastPathEligible) {
        signalUsed = 'persistent_rejects';
      } else {
        const allStale = sessions.every(
          (s) => now.getTime() - Date.parse(s.lastUpdate as string) > this.tuning.staleMs,
        );
        if (!allStale) {
          if (!bypassGates) {
            return await this.finishSkip(input, 'skipped_alive', 'session_fresh_interim');
          }
          // force bypassa el gate alive: cura igual, SIN signal (el operador ES la evidencia).
        } else if (input.trigger === 'auto') {
          signalUsed = 'stale_interim';
        }
      }

      // ── Cura efectiva: TODAS las sesiones sobrevivientes (S2.8: mismo NAS por construcción). ──
      const forcedReason = input.trigger === 'manual' && input.force ? 'forced' : null;
      const events: RadiusSessionCureEvent[] = [];
      for (const s of sessions) {
        events.push(await this.cureOne(input, s, signalUsed, forcedReason));
      }

      return { outcome: deriveOverallOutcome(events), reason: events[0]?.reason ?? null, events, registrationThrottled: false };
    } catch (err) {
      // S3.3 (aislamiento): un fallo ANTES de la cura (típicamente gateway.listSessions caído)
      // se registra como 'failed' — el caller (watcher) sigue con el próximo candidato.
      return this.finishSkip(input, 'failed', cureErrorReason(err));
    }
  }

  private async cureOne(
    input: CureStuckSessionInput,
    session: OrchestratorSession,
    signalUsed: RadiusSessionCureSignal | null,
    forcedReason: string | null,
  ): Promise<RadiusSessionCureEvent> {
    try {
      const result = await this.gateway.cureSession(input.username, session.sessionId);
      const outcome: RadiusSessionCureOutcome = result.cured ? 'cured' : 'already_cured';
      return this.cureEventRepo.record({
        username: input.username,
        nasIp: session.nasIp,
        sessionId: session.sessionId,
        sessionStartedAt: session.startedAt,
        sessionLastUpdate: session.lastUpdate ?? null,
        signalUsed,
        trigger: input.trigger,
        action: deriveAction(result.cured, result.coa),
        outcome,
        reason: forcedReason,
        actorName: input.actorName,
      });
    } catch (err) {
      return this.cureEventRepo.record({
        username: input.username,
        nasIp: session.nasIp,
        sessionId: session.sessionId,
        sessionStartedAt: session.startedAt,
        sessionLastUpdate: session.lastUpdate ?? null,
        signalUsed,
        trigger: input.trigger,
        action: null,
        outcome: 'failed',
        reason: cureErrorReason(err),
        actorName: input.actorName,
      });
    }
  }

  /**
   * Registra un outcome de SKIP (no_session/ambiguous/no_signal/alive) aplicando el throttle de
   * registro de 6h — SOLO para trigger 'auto' (REQ-CURE-6: el manual SIEMPRE registra).
   */
  private async finishSkip(
    input: CureStuckSessionInput,
    outcome: RadiusSessionCureOutcome,
    reason: string,
  ): Promise<CureStuckSessionResult> {
    const now = input.now ?? new Date();
    if (input.trigger === 'auto') {
      const duplicate = await isDuplicateCureEvent(this.cureEventRepo, input.username, outcome, reason, now.getTime());
      if (duplicate) {
        return { outcome, reason, events: [], registrationThrottled: true };
      }
    }
    const event = await this.cureEventRepo.record({
      username: input.username,
      trigger: input.trigger,
      outcome,
      reason,
      actorName: input.actorName,
    });
    return { outcome, reason, events: [event], registrationThrottled: false };
  }
}

function deriveAction(cured: boolean, coa: CoAResult[]): RadiusSessionCureAction | null {
  const ack = coa.some((c) => c.status === 'ack');
  if (cured) return ack ? 'both' : 'acct_close';
  return ack ? 'coa' : null;
}

function deriveOverallOutcome(events: RadiusSessionCureEvent[]): RadiusSessionCureOutcome {
  if (events.length === 0) return 'failed';
  if (events.some((e) => e.outcome === 'cured')) return 'cured';
  if (events.every((e) => e.outcome === 'already_cured')) return 'already_cured';
  return 'failed';
}

function cureErrorReason(err: unknown): string {
  if (err instanceof OrchestratorRejectedError && err.upstreamStatus === 404) return 'session_not_found';
  if (err instanceof OrchestratorUnreachableError) return 'orchestrator_unreachable';
  return err instanceof Error ? err.message : 'unknown_error';
}
