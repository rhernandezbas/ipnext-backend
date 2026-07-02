import { NasServer } from '@domain/entities/nas';
import { NasRepository } from '@domain/ports/NasRepository';
import {
  PppoeServiceRepository,
  PppoeServiceWithClient,
} from '@domain/ports/PppoeServiceRepository';
import { IpNetworkRepository } from '@domain/ports/IpNetworkRepository';
import {
  RadiusOrchestratorGateway,
  OrchestratorSession,
} from '@domain/ports/RadiusOrchestratorGateway';
import {
  PppoeNasMoveEventRepository,
  PppoeNasMoveOutcome,
} from '@domain/ports/PppoeNasMoveEventRepository';
import { ipInAnyRange } from '@domain/services/ipMath';
import { isDuplicateAutoEvent } from '@application/services/pppoeNasMoveThrottle';
import { MovePppoeToNas } from './MovePppoeToNas';

/** Tamaño de página para paginar el GET /sessions del orchestrator (patrón OrchestratorRadiusSessionRepository). */
const PAGE_SIZE = 500;

/** Resumen de UN tick del watcher (D-W2.3): se loguea estructurado por el scheduler. */
export interface AutoMovePppoeSummary {
  /** Sesiones vivas crudas devueltas por el orchestrator. */
  sessions: number;
  /** Usernames cuyo NAS real (por sesión) ≠ NAS asignado (service.nasId). */
  mismatches: number;
  /** Moves ejecutados con éxito por MovePppoeToNas. */
  moved: number;
  /** Mismatches NO accionables: IP pública (reason public_pool) o fuera de todo pool (unclassified_ip). */
  skippedPublic: number;
  /** Sesiones cuya nasIpAddress no mapea a ningún NasServer del inventario. */
  skippedUnknownNas: number;
  /** Moves intentados que fallaron (p.ej. pool destino lleno) — el core ya registró su fila. */
  failed: number;
  /** Filas de skip suprimidas por el throttle de 6h (el skip igual ocurrió). Solo cuenta las
   *  supresiones del PROPIO watcher; las de los failed_* del core no son visibles acá. */
  throttled: number;
  /** Sesiones sin PppoeService espejado en Prominense (se ignoran, sin fila). */
  ignoredNoService: number;
}

/**
 * AutoMovePppoe (pppoe-move-nas W2, design D4 + D-W2.1..D-W2.4) — UN tick de detección+acción
 * del watcher de mismatches NAS real vs asignado.
 *
 * Detección (D-W2.4):
 *   1. sesiones vivas del orchestrator (GET /sessions, paginado — ~2.8k filas hoy)
 *   2. map NasServer.nasIpAddress → NasServer (1 query, los ~10 NAS)
 *   3. servicios espejados por username (1 query batch)
 *   4. mismatch = NAS real de la sesión ≠ service.nasId
 *
 * Reglas por username (D-W2.1):
 *   - varias sesiones vivas: gana la más RECIENTE (startedAt); si están en NAS DISTINTOS entre sí
 *     (transitorio de re-auth) → saltear este tick (converge solo, sin fila).
 *   - sin PppoeService espejado → ignorar (contador, sin fila).
 *   - nasIpAddress desconocida → evento `skipped_unknown_nas` (throttled), sin move.
 *   - PRE-clasificación de la IP ACTUAL contra los pools cargados (misma semántica FAIL-CLOSED
 *     que el guard S1.5 del core — NUNCA depender del 409):
 *       · en pool cgnat (o servicio SIN IP: no hay IP que perder, el core tampoco exige force)
 *         → MovePppoeToNas con trigger 'auto', SIN force (el core registra moved/failed_* y el
 *         historial con actor 'sistema').
 *       · pública o fuera de todo pool → evento `skipped_public` (reason public_pool |
 *         unclassified_ip, throttled), SIN llamar al move.
 *   - aislamiento por ítem (S6.1): un fallo NO aborta el tick — se cuenta y se sigue.
 *
 * Throttle (D-W2.2 / S10.5): los `skipped_*` de este watcher se registran vía `recordSkip`
 * (chequeo del último evento del username, ventana 6h); los `failed_*` los registra el CORE,
 * que aplica el MISMO throttle para trigger 'auto' (ver MovePppoeToNas.recordMoveEvent).
 *
 * Depende SOLO de ports + el core de W1 como colaborador. Cero infra.
 */
export class AutoMovePppoe {
  private readonly now: () => Date;

  constructor(
    private readonly orchestrator: RadiusOrchestratorGateway,
    private readonly nasRepo: NasRepository,
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly networkRepo: IpNetworkRepository,
    private readonly moveEventRepo: PppoeNasMoveEventRepository,
    private readonly movePppoeToNas: MovePppoeToNas,
    opts?: { now?: () => Date },
  ) {
    this.now = opts?.now ?? (() => new Date());
  }

  async run(): Promise<AutoMovePppoeSummary> {
    const summary: AutoMovePppoeSummary = {
      sessions: 0, mismatches: 0, moved: 0, skippedPublic: 0,
      skippedUnknownNas: 0, failed: 0, throttled: 0, ignoredNoService: 0,
    };

    const sessions = await this.fetchAllSessions();
    summary.sessions = sessions.length;
    if (sessions.length === 0) return summary;

    // Agrupar por username preservando el orden de aparición.
    const byUser = new Map<string, OrchestratorSession[]>();
    for (const s of sessions) {
      const list = byUser.get(s.username);
      if (list) list.push(s);
      else byUser.set(s.username, [s]);
    }

    const nasByIp = new Map<string, NasServer>(
      (await this.nasRepo.findAllNasServers()).map(n => [n.nasIpAddress, n] as const),
    );
    const serviceByUser = new Map<string, PppoeServiceWithClient>(
      (await this.pppoeRepo.findByUsernames([...byUser.keys()])).map(s => [s.username, s] as const),
    );
    const pools = await this.networkRepo.findAllPools();
    const cgnatPools  = pools.filter(p => p.ipKind === 'cgnat');
    const publicPools = pools.filter(p => p.ipKind === 'public');

    for (const [username, userSessions] of byUser) {
      // Sesiones vivas en NAS DISTINTOS entre sí = transitorio de re-auth → saltear el tick.
      if (new Set(userSessions.map(s => s.nasIp)).size > 1) {
        console.warn(
          `[AutoMovePppoe] '${username}' con sesiones vivas en NAS distintos entre sí (transitorio) — tick salteado`,
        );
        continue;
      }
      const session = mostRecent(userSessions);

      const service = serviceByUser.get(username);
      if (!service) {
        // Sin espejo en Prominense (placeholder/no adoptado): nada que mover, sin fila.
        summary.ignoredNoService++;
        continue;
      }

      const realNas = nasByIp.get(session.nasIp);
      if (!realNas) {
        // NAS fantasma: nasIpAddress mal cargada o NAS fuera del inventario (S4.2). El aviso
        // debe ser VISIBLE (fila) y no solo stdout — pero throttled para no spamear el tab.
        summary.skippedUnknownNas++;
        console.warn(
          `[AutoMovePppoe] auto-move skipped: unknown NAS — username=${username} nasIp=${session.nasIp} asignado=${service.nasId}`,
        );
        await this.recordSkip(service, 'skipped_unknown_nas', `nas_ip_not_registered:${session.nasIp}`, null, summary);
        continue;
      }

      if (realNas.id === service.nasId) continue; // sin mismatch
      summary.mismatches++;

      // PRE-clasificación FAIL-CLOSED de la IP actual (D-W2.1 / REQ-AUTO-2): solo una IP
      // clasificada POSITIVAMENTE como cgnat es auto-movible. IP null → no hay IP que perder
      // (misma semántica que el guard del core) → elegible.
      const ip = service.remoteAddress;
      if (ip && !ipInAnyRange(ip, cgnatPools)) {
        const reason = ipInAnyRange(ip, publicPools) ? 'public_pool' : 'unclassified_ip';
        summary.skippedPublic++;
        console.warn(
          `[AutoMovePppoe] auto-move skipped: ${reason} — username=${username} ip=${ip} ` +
          `asignado=${service.nasId} real=${realNas.id} (${realNas.name})`,
        );
        await this.recordSkip(service, 'skipped_public', reason, realNas.id, summary);
        continue;
      }

      // Move radius-aware de W1 con trigger 'auto', SIN force y SIN actor (el core cae a
      // 'sistema'). Aislamiento por ítem: el core ya registró su propio evento failed_* —
      // acá solo se cuenta y se sigue con el resto (S6.1).
      try {
        await this.movePppoeToNas.execute({ id: service.id, nasId: realNas.id, trigger: 'auto' });
        summary.moved++;
      } catch (err) {
        summary.failed++;
        console.warn(
          `[AutoMovePppoe] auto-move FAILED — username=${username} → ${realNas.name}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return summary;
  }

  /** Carga TODAS las sesiones vivas paginando el GET /sessions (patrón fetchAll existente). */
  private async fetchAllSessions(): Promise<OrchestratorSession[]> {
    const all: OrchestratorSession[] = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this.orchestrator.listActiveSessions(offset, PAGE_SIZE);
      all.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return all;
  }

  /**
   * Registra un `skipped_*` del watcher con throttle de 6h (S10.5) — best-effort: el registro
   * NUNCA tumba el tick. La fila suprimida por throttle cuenta en `summary.throttled`.
   */
  private async recordSkip(
    service: PppoeServiceWithClient,
    outcome: Extract<PppoeNasMoveOutcome, 'skipped_public' | 'skipped_unknown_nas'>,
    reason: string,
    toNasId: string | null,
    summary: AutoMovePppoeSummary,
  ): Promise<void> {
    try {
      if (await isDuplicateAutoEvent(this.moveEventRepo, service.username, outcome, toNasId, this.now().getTime())) {
        summary.throttled++;
        return;
      }
      await this.moveEventRepo.record({
        username:       service.username,
        pppoeServiceId: service.id,
        fromNasId:      service.nasId,
        toNasId,
        fromIp:         service.remoteAddress,
        toIp:           null,
        trigger:        'auto',
        outcome,
        reason,
        actorName:      'sistema',
      });
    } catch (err) {
      console.warn('[AutoMovePppoe] Failed to record skip event (best-effort):', err);
    }
  }
}

/** La sesión más reciente por startedAt (startedAt no parseable cuenta como epoch 0). */
function mostRecent(sessions: OrchestratorSession[]): OrchestratorSession {
  return sessions.reduce((best, s) => (startedAtMs(s) >= startedAtMs(best) ? s : best));
}

function startedAtMs(s: OrchestratorSession): number {
  const ms = Date.parse(s.startedAt);
  return Number.isNaN(ms) ? 0 : ms;
}
