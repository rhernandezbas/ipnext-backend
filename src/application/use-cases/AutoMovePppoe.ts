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
import { isDuplicateAutoEvent, AUTO_MOVE_EVENT_THROTTLE_MS } from '@application/services/pppoeNasMoveThrottle';
import { MovePppoeToNas } from './MovePppoeToNas';

/** Tamaño de página para paginar el GET /sessions del orchestrator (patrón OrchestratorRadiusSessionRepository). */
const PAGE_SIZE = 500;

/**
 * Tuning del watcher (D-W2.5, items 1/2/4). Los defaults son los del design; en prod los pisan
 * las envs AUTO_MOVE_* vía config (inyectadas por bootstrapPppoeAutoMove — parse seguro, el
 * boot nunca falla por una env rota).
 */
export interface AutoMovePppoeTuning {
  /** C3: mismatches del tick > umbral ⇒ ABORTAR el tick entero (huele a error de inventario). */
  abortThreshold?: number;
  /** C3: a lo sumo N moves por tick; el resto queda `deferred` para el próximo. */
  maxMovesPerTick?: number;
  /** C2a: ventana anti-revert vs el último evento 'moved' del username (cualquier trigger). */
  cooldownMs?: number;
  /** C1: actividad mínima de la sesión ganadora (fallback startedAt — ver nota en run()). */
  sessionFreshnessMs?: number;
}

const DEFAULT_ABORT_THRESHOLD     = 25;
const DEFAULT_MAX_MOVES_PER_TICK  = 10;
const DEFAULT_COOLDOWN_MS         = 600_000;     // 10 min
const DEFAULT_SESSION_FRESHNESS_MS = 259_200_000; // 72 h

/** Resumen de UN tick del watcher (D-W2.3 + D-W2.5 item 8): se loguea estructurado por el scheduler. */
export interface AutoMovePppoeSummary {
  /** Sesiones vivas crudas devueltas por el orchestrator. */
  sessions: number;
  /**
   * Usernames cuyo NAS real (por sesión) ≠ NAS asignado (service.nasId), EXCLUYENDO las
   * adopciones (D6.1): SOLO los mismatches reales alimentan el circuit breaker — un pendiente
   * con sesión no es evidencia de inventario roto.
   */
  mismatches: number;
  /**
   * pppoe-preprovision D6.1: pendientes de instalación (nasId null) con sesión viva detectados
   * este tick (candidatos a ADOPCIÓN). Se cuentan APARTE de `mismatches` (no abortan el tick);
   * comparten el CAP con los moves (el excedente queda `deferred`).
   */
  adoptions: number;
  /** Moves REALES ejecutados con éxito por MovePppoeToNas (S10: nunca cuenta no-ops). */
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
  /** C3: true si el tick se ABORTÓ entero (mismatches > abortThreshold) — cero moves, cero filas. */
  aborted: boolean;
  /** C3: mismatches accionables que quedaron fuera del cap de este tick (se reintentan al próximo). */
  deferred: number;
  /** C2a: moves salteados por cooldown anti-revert (último 'moved' demasiado reciente). Sin fila. */
  skippedCooldown: number;
  /** C2b: el re-fetch pre-execute encontró el servicio YA en el NAS target (move manual cruzado). */
  alreadyConverged: number;
  /** W4: servicios terminated con sesión viva — pre-filtrados sin core call ni fila. */
  skippedTerminated: number;
  /** C1: mismatches cuya sesión ganadora no tiene actividad reciente (fila skipped_stale_session). */
  skippedStale: number;
  /** W7: usernames con sesiones vivas en NAS distintos entre sí (fila skipped_nas_conflict). */
  nasConflicts: number;
  /**
   * D6.3 (anti-starvation del cap): candidatos salteados BAJO PRESIÓN de cap porque su último
   * evento es un failed_* idéntico (<6h, mismo toNas, username exacto). Sin fila (la del fallo
   * anterior sigue visible); reintentan al expirar la ventana o al aflojar la presión.
   */
  skippedRecentFailure: number;
}

/** Un mismatch accionable detectado en la fase de clasificación (pendiente de move). */
interface MoveCandidate {
  service: PppoeServiceWithClient;
  realNas: NasServer;
}

/** Una fila de skip pendiente de registro (se persiste SOLO si el tick no aborta). */
interface PendingSkip {
  service: PppoeServiceWithClient;
  outcome: Extract<
    PppoeNasMoveOutcome,
    'skipped_public' | 'skipped_unknown_nas' | 'skipped_stale_session' | 'skipped_nas_conflict'
  >;
  reason: string;
  toNasId: string | null;
}

/**
 * AutoMovePppoe (pppoe-move-nas W2, design D4 + D-W2.1..D-W2.5) — UN tick de detección+acción
 * del watcher de mismatches NAS real vs asignado.
 *
 * Detección (D-W2.4):
 *   1. sesiones vivas del orchestrator (GET /sessions, paginado — ~2.8k filas hoy)
 *   2. map NasServer.nasIpAddress → NasServer (1 query, los ~10 NAS)
 *   3. servicios espejados por username (1 query batch)
 *   4. mismatch = NAS real de la sesión ≠ service.nasId
 *
 * El tick corre en DOS fases (D-W2.5 item 1 — el breaker exige contar ANTES de actuar):
 *
 * FASE 1 — clasificación (sin efectos): cada username cae en exactamente un bucket:
 *   - sin PppoeService espejado → ignorar (contador, sin fila)
 *   - `status==='terminated'` (W4) → contador skippedTerminated, SIN fila y SIN core call
 *     (antes el core lo rechazaba con 409 y el watcher sumaba un failed++ eterno e invisible)
 *   - sesiones vivas en NAS DISTINTOS entre sí (W7) → fila `skipped_nas_conflict` (throttled):
 *     es el estado terminal del C1 (stale colgada en un NAS + sesión real en otro) y tiene que
 *     verse en el tab, no en stdout
 *   - nasIpAddress desconocida → fila `skipped_unknown_nas` (throttled), sin move
 *   - NAS real == asignado → convergido, nada
 *   - mismatch:
 *       · freshness gate (C1): la sesión GANADORA (más reciente) debe tener actividad más nueva
 *         que sessionFreshnessMs. El wire del GET /sessions del orchestrator NO trae
 *         lastUpdate/acctupdatetime (verificado en schemas/session.py: session_id, username,
 *         nas_ip, framed_ip, started_at, bytes_in/out, caller_id) → fallback `startedAt`, como
 *         manda el design. Sesión vieja ⇒ fila `skipped_stale_session` (throttled), CERO move:
 *         una colgada (acctstoptime NULL viejo) jamás mueve a un cliente offline al NAS fantasma.
 *       · PRE-clasificación FAIL-CLOSED de la IP actual (D-W2.1): solo IP positivamente cgnat
 *         (o servicio sin IP) es auto-movible; pública/fuera de pool ⇒ fila `skipped_public`.
 *       · elegible ⇒ candidato a move.
 *
 * CIRCUIT BREAKER (C3 + D6.1): mismatches REALES > abortThreshold ⇒ ABORTAR el tick ENTERO —
 * cero moves y cero filas (datos sospechosos: NAS duplicado en el inventario, nasIpAddress mal
 * editada). WARN + `aborted: true` en el summary. Las ADOPCIONES (pendientes de instalación,
 * nasId null) se cuentan APARTE (`summary.adoptions`) y NO alimentan el breaker — pendientes
 * acumulados son el modo esperado con flag OFF, no inventario roto; el CAP los drena.
 * También están EXENTAS del freshness gate (D6.2 — username nuevo, sin colgadas históricas).
 *
 * FASE 2 — acción: se registran las filas de skip (throttle 6h) y se procesan a lo sumo
 * maxMovesPerTick candidatos (el resto → `deferred`). D6.3: bajo PRESIÓN de cap, un candidato
 * cuyo último evento es un failed_* idéntico (<6h, mismo toNas, username exacto) NO consume
 * slot (`skippedRecentFailure`, sin fila). Por CADA candidato que entra al cap, en orden:
 *   a. cooldown anti-revert (C2a): último evento 'moved' del username (CUALQUIER trigger)
 *      < cooldownMs ⇒ skippedCooldown, sin fila — no deshacer un move manual recién hecho
 *      (con kick fallido la sesión vieja sigue viva por horas y parece mismatch). Error del
 *      check ⇒ FAIL-CLOSED (skip: ante la duda un watcher autónomo NO mueve; reintenta luego).
 *   b. re-fetch del servicio (C2b): nasId ya == target ⇒ alreadyConverged (el snapshot batch
 *      envejeció durante el loop); terminated fresco ⇒ skippedTerminated; fila borrada ⇒ skip.
 *   c. re-fetch de las sesiones del username (C2b): si el ganador FRESCO ya no apunta al
 *      target ⇒ skip (re-auth cruzada durante el tick).
 *   d. MovePppoeToNas trigger 'auto', SIN force (el core registra moved/failed_* y el
 *      historial con actor 'sistema'). moved++ SOLO acá (S10: nunca sobre no-ops).
 *   Aislamiento por ítem (S6.1): un fallo NO aborta el tick — se cuenta y se sigue.
 *
 * Throttle (D-W2.2 / D-W2.5 item 7): los `skipped_*` de este watcher se registran vía
 * `recordSkip` (identidad outcome+toNasId+reason, username EXACTO, solo suprime si el último
 * evento es 'auto', fail-open); los `failed_*` los registra el CORE con el MISMO helper.
 *
 * Depende SOLO de ports + el core de W1 como colaborador. Cero infra.
 */
export class AutoMovePppoe {
  private readonly now: () => Date;
  private readonly abortThreshold: number;
  private readonly maxMovesPerTick: number;
  private readonly cooldownMs: number;
  private readonly sessionFreshnessMs: number;

  constructor(
    private readonly orchestrator: RadiusOrchestratorGateway,
    private readonly nasRepo: NasRepository,
    private readonly pppoeRepo: PppoeServiceRepository,
    private readonly networkRepo: IpNetworkRepository,
    private readonly moveEventRepo: PppoeNasMoveEventRepository,
    private readonly movePppoeToNas: MovePppoeToNas,
    opts?: { now?: () => Date } & AutoMovePppoeTuning,
  ) {
    this.now                = opts?.now ?? (() => new Date());
    this.abortThreshold     = opts?.abortThreshold ?? DEFAULT_ABORT_THRESHOLD;
    this.maxMovesPerTick    = opts?.maxMovesPerTick ?? DEFAULT_MAX_MOVES_PER_TICK;
    this.cooldownMs         = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.sessionFreshnessMs = opts?.sessionFreshnessMs ?? DEFAULT_SESSION_FRESHNESS_MS;
  }

  async run(): Promise<AutoMovePppoeSummary> {
    const summary: AutoMovePppoeSummary = {
      sessions: 0, mismatches: 0, adoptions: 0, moved: 0, skippedPublic: 0,
      skippedUnknownNas: 0, failed: 0, throttled: 0, ignoredNoService: 0,
      aborted: false, deferred: 0, skippedCooldown: 0, alreadyConverged: 0,
      skippedTerminated: 0, skippedStale: 0, nasConflicts: 0, skippedRecentFailure: 0,
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

    // ── FASE 1 — clasificación (sin efectos: el breaker decide ANTES de escribir nada) ────────
    const candidates: MoveCandidate[] = [];
    const pendingSkips: PendingSkip[] = [];

    for (const [username, userSessions] of byUser) {
      const service = serviceByUser.get(username);
      if (!service) {
        // Sin espejo en Prominense (placeholder/no adoptado): nada que mover, sin fila.
        summary.ignoredNoService++;
        continue;
      }

      // W4 (D-W2.5 item 6): la lápida terminated se pre-filtra ANTES de cualquier registro o
      // core call — se acabó el failed++ eterno invisible (el guard 409 del core no deja fila).
      if (service.status === 'terminated') {
        summary.skippedTerminated++;
        continue;
      }

      // W7 (D-W2.5 item 5): sesiones vivas en NAS DISTINTOS entre sí. Puede ser el transitorio
      // de una re-auth (converge solo) o el estado TERMINAL de una sesión colgada en un NAS
      // fantasma — fila VISIBLE (throttled) en vez del WARN de stdout.
      const distinctNasIps = new Set(userSessions.map(s => s.nasIp));
      if (distinctNasIps.size > 1) {
        summary.nasConflicts++;
        console.warn(
          `[AutoMovePppoe] '${username}' con sesiones vivas en NAS distintos entre sí — skip del tick (skipped_nas_conflict)`,
        );
        pendingSkips.push({
          service,
          outcome: 'skipped_nas_conflict',
          // Reason ESTABLE (las IPs ordenadas) para que el throttle reconozca el duplicado.
          reason: `sessions_on_multiple_nas:${[...distinctNasIps].sort().join(',')}`,
          toNasId: null,
        });
        continue;
      }
      const winner = mostRecent(userSessions);

      const realNas = nasByIp.get(winner.nasIp);
      if (!realNas) {
        // NAS fantasma: nasIpAddress mal cargada o NAS fuera del inventario (S4.2).
        summary.skippedUnknownNas++;
        console.warn(
          `[AutoMovePppoe] auto-move skipped: unknown NAS — username=${username} nasIp=${winner.nasIp} asignado=${service.nasId}`,
        );
        pendingSkips.push({
          service,
          outcome: 'skipped_unknown_nas',
          reason: `nas_ip_not_registered:${winner.nasIp}`,
          toNasId: null,
        });
        continue;
      }

      // pppoe-preprovision (D4 / REQ-PRE-3 + D6.1): un servicio con nasId === null (pre-provisión
      // "pendiente de instalación") con sesión viva NO es un mismatch clásico — es una ADOPCIÓN.
      // Comparte el pipeline (terminated/conflicto multi-NAS ya corrieron arriba; IP null →
      // elegible abajo; mismo CAP y mismo cooldown) con DOS excepciones deliberadas del D6:
      //   · D6.1: se cuenta APARTE (summary.adoptions) — NO alimenta el circuit breaker. El
      //     breaker protege contra inventario roto; N pendientes acumulados (flag OFF unos días
      //     = modo esperado pre-go-live) no son evidencia de nada roto. Sin esto, 26+ pendientes
      //     abortaban el tick PARA SIEMPRE (cero adopciones, cero moves, cero filas).
      //   · D6.2: EXENTA del freshness gate — un username pre-provisionado es NUEVO (no existen
      //     colgadas históricas de él); una sesión vieja en el pool preinstall = el CPE instalado
      //     ESPERANDO la adopción (instalado lunes, flag ON jueves). Peor caso: adoptar con el
      //     cliente ya offline → converge solo cuando vuelve.
      // El core (MovePppoeToNas) asigna del pool del ipTypePreference persistido y registra el
      // evento moved con reason 'auto_install' y fromNas null.
      const isAdoption = service.nasId === null;
      if (!isAdoption && realNas.id === service.nasId) continue; // sin mismatch
      if (isAdoption) summary.adoptions++;
      else summary.mismatches++;

      // C1 (D-W2.5 item 4): freshness de la sesión ganadora — SOLO mismatches reales (D6.2
      // exime a las adopciones, ver arriba). El wire de /sessions NO trae lastUpdate/
      // acctupdatetime → fallback startedAt (design). Una sesión colgada vieja (acctstoptime
      // NULL) como única sesión NO mueve a un cliente offline al NAS fantasma.
      // startedAt no parseable cuenta como epoch 0 → stale (fail-safe).
      if (!isAdoption) {
        const activityAge = this.now().getTime() - startedAtMs(winner);
        if (activityAge > this.sessionFreshnessMs) {
          summary.skippedStale++;
          console.warn(
            `[AutoMovePppoe] auto-move skipped: stale winner session — username=${username} ` +
            `startedAt=${winner.startedAt} nasReal=${realNas.id} (${realNas.name})`,
          );
          pendingSkips.push({
            service,
            outcome: 'skipped_stale_session',
            // Reason ESTABLE (derivado del umbral configurado, no de la edad) para el throttle.
            reason: `winner_session_stale_gt_${Math.round(this.sessionFreshnessMs / 3_600_000)}h`,
            toNasId: realNas.id,
          });
          continue;
        }
      }

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
        pendingSkips.push({ service, outcome: 'skipped_public', reason, toNasId: realNas.id });
        continue;
      }

      candidates.push({ service, realNas });
    }

    // ── CIRCUIT BREAKER (C3, D-W2.5 item 1 + D6.1) ─────────────────────────────────────────────
    // Más mismatches REALES que el umbral en UN tick huele a error de inventario (NAS duplicado,
    // nasIpAddress mal editada): abortar el tick ENTERO sin escribir NADA (ni moves ni filas —
    // con datos sospechosos hasta las filas de skip serían ruido masivo). Las ADOPCIONES no
    // suman al umbral (D6.1) pero un abort también las frena: el tick entero es sospechoso.
    if (summary.mismatches > this.abortThreshold) {
      summary.aborted = true;
      console.warn(
        `[AutoMovePppoe] tick ABORTADO: ${summary.mismatches} mismatches > umbral ${this.abortThreshold} ` +
        `(huele a error de inventario — revisar NasServer.nasIpAddress). CERO moves ejecutados.`,
      );
      return summary;
    }

    // ── FASE 2 — acción ────────────────────────────────────────────────────────────────────────
    for (const skip of pendingSkips) {
      await this.recordSkip(skip, summary);
    }

    // Cap de moves por tick (C3): el resto queda para el próximo tick (el mismatch persiste
    // y se re-detecta — no hace falta cola).
    //
    // D6.3 — anti-starvation del cap: BAJO PRESIÓN (más candidatos que slots), un candidato
    // cuyo último evento es un failed_* idéntico (<6h, mismo toNas, username exacto) NO consume
    // slot: se saltea (skippedRecentFailure, SIN fila — la del fallo anterior sigue visible) y
    // reintenta al expirar la ventana. Sin esto, un 'public' sin pool cargado (falla PERMANENTE,
    // orden de candidatos estable tick a tick) quema 1 de los 10 slots CADA tick para siempre.
    // SIN presión de cap el check ni corre: el retry barato de D-W2.2 queda intacto (pool lleno
    // se reintenta cada tick y converge apenas se libera lugar; el registro ya lo throttlea el core).
    const capPressure = candidates.length > this.maxMovesPerTick;
    let processed = 0;

    for (const { service, realNas } of candidates) {
      if (processed >= this.maxMovesPerTick) {
        summary.deferred++;
        continue;
      }
      if (capPressure && (await this.hasRecentIdenticalFailure(service.username, realNas.id))) {
        summary.skippedRecentFailure++;
        continue;
      }
      processed++;
      try {
        // C2a — cooldown anti-revert: el último 'moved' del username (CUALQUIER trigger) manda.
        // Error del check ⇒ FAIL-CLOSED: ante la duda, un watcher autónomo NO mueve (reintenta
        // el próximo tick) — lo opuesto al throttle de REGISTRO, que es fail-open.
        let inCooldown: boolean;
        try {
          const { items } = await this.moveEventRepo.list({
            page: 1, limit: 1, usernameExact: service.username, outcome: 'moved',
          });
          const last = items[0];
          const age = last ? this.now().getTime() - Date.parse(last.createdAt) : Number.POSITIVE_INFINITY;
          inCooldown = Number.isFinite(age) && age < this.cooldownMs;
        } catch (err) {
          console.warn(
            `[AutoMovePppoe] check de cooldown falló para '${service.username}' — FAIL-CLOSED (skip del move):`,
            err,
          );
          inCooldown = true;
        }
        if (inCooldown) {
          summary.skippedCooldown++;
          continue;
        }

        // C2b(a) — re-fetch del servicio: el snapshot batch envejeció durante el loop.
        const fresh = await this.pppoeRepo.findById(service.id);
        if (!fresh) {
          console.warn(`[AutoMovePppoe] '${service.username}' desapareció durante el tick — skip`);
          continue;
        }
        if (fresh.nasId === realNas.id) {
          // Un move manual cruzado ya lo dejó en el target: NO es un move nuestro (S10).
          summary.alreadyConverged++;
          continue;
        }
        if (fresh.status === 'terminated') {
          summary.skippedTerminated++;
          continue;
        }

        // C2b(b) — re-fetch de las sesiones: el ganador FRESCO tiene que seguir apuntando al
        // target; si no (re-auth cruzada, sesión cerrada), el mismatch del snapshot ya no vale.
        const freshSessions = await this.orchestrator.listSessions(service.username);
        const freshWinner = freshSessions.length > 0 ? mostRecent(freshSessions) : undefined;
        if (!freshWinner || freshWinner.nasIp !== realNas.nasIpAddress) {
          console.warn(
            `[AutoMovePppoe] '${service.username}': la sesión ganadora fresca ya no apunta a ${realNas.name} — skip (snapshot envejecido)`,
          );
          continue;
        }

        // Move radius-aware de W1 con trigger 'auto', SIN force y SIN actor (el core cae a
        // 'sistema'). moved++ SOLO tras un move real (el pre-check de convergencia de arriba
        // evita contar no-ops — S10).
        await this.movePppoeToNas.execute({ id: service.id, nasId: realNas.id, trigger: 'auto' });
        summary.moved++;
      } catch (err) {
        // Aislamiento por ítem (S6.1): el core ya registró su propio evento failed_* —
        // acá solo se cuenta y se sigue con el resto.
        summary.failed++;
        console.warn(
          `[AutoMovePppoe] auto-move FAILED — username=${service.username} → ${realNas.name}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (summary.deferred > 0) {
      console.warn(
        `[AutoMovePppoe] cap de ${this.maxMovesPerTick} moves/tick alcanzado — ${summary.deferred} candidatos quedan para el próximo tick`,
      );
    }

    return summary;
  }

  /**
   * D6.3 — ¿el ÚLTIMO evento del username (match EXACTO) es un `failed_*` hacia el MISMO NAS
   * destino con menos de 6h (la ventana del throttle)? Solo se consulta BAJO PRESIÓN de cap.
   * FAIL-OPEN: si el check lanza (DB hiccup), el candidato se procesa normal — el pipeline
   * tiene sus propios guards fail-closed (cooldown, re-verify) antes de mover.
   */
  private async hasRecentIdenticalFailure(username: string, toNasId: string): Promise<boolean> {
    try {
      const { items } = await this.moveEventRepo.list({ page: 1, limit: 1, usernameExact: username });
      const last = items[0];
      if (!last) return false;
      if (!last.outcome.startsWith('failed_')) return false;
      if ((last.toNasId ?? null) !== toNasId) return false;
      const age = this.now().getTime() - Date.parse(last.createdAt);
      return Number.isFinite(age) && age < AUTO_MOVE_EVENT_THROTTLE_MS;
    } catch (err) {
      console.warn(
        `[AutoMovePppoe] check de fallo reciente falló para '${username}' — FAIL-OPEN (se procesa normal):`,
        err,
      );
      return false;
    }
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
   * Registra un `skipped_*` del watcher con throttle de 6h (S10.5 / D-W2.5 item 7) — best-effort:
   * el registro NUNCA tumba el tick. La fila suprimida por throttle cuenta en `summary.throttled`.
   * El check del throttle es FAIL-OPEN (vive en isDuplicateAutoEvent): si la DB hipa, la fila
   * se registra igual.
   */
  private async recordSkip(skip: PendingSkip, summary: AutoMovePppoeSummary): Promise<void> {
    const { service, outcome, reason, toNasId } = skip;
    try {
      if (
        await isDuplicateAutoEvent(
          this.moveEventRepo, service.username, outcome, toNasId, reason, this.now().getTime(),
        )
      ) {
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
