import { OltProvisioningGateway } from '@domain/ports/OltProvisioningGateway';
import {
  FiberAutoProvisionTaskRepository,
  FiberAutoProvisionCandidateTask,
} from '@domain/ports/FiberAutoProvisionTaskRepository';
import {
  FiberAutoProvisionAttempt,
  FiberAutoProvisionAttemptRepository,
} from '@domain/ports/FiberAutoProvisionAttemptRepository';
import { normalizeOnuSerial } from '@domain/services/fiberProvisioning';
import {
  FiberVlanRequiredError,
  OnuNotHuaweiError,
  UnconfiguredOnuNotFoundError,
} from '@domain/errors/smartolt';
import { ProvisionFiberOnu } from './ProvisionFiberOnu';

/** Máximo de intentos por (taskId, onuSn) — al 3er fallo se deja de insistir. */
const MAX_ATTEMPTS = 3;

// ── Notas del watcher en la description de la tarea (texto = wire contract con el
//    instalador; los tests las pinean). Cada nota se escribe UNA sola vez: el estado
//    terminal persistido en FiberAutoProvisionAttempt evita duplicados entre ticks. ──

export const WATCHER_NOTE_VLAN_MANUAL =
  '⚠ Auto-aprovisionamiento: esta OLT requiere VLAN manual — usar el botón de aprovisionamiento (wizard de fibra).';

export const WATCHER_NOTE_NON_HUAWEI =
  '⚠ Auto-aprovisionamiento: ONU no-Huawei — aprovisionar manualmente en SmartOLT.';

export function watcherNoteFailedFinal(attempts: number, lastError: string): string {
  return `⚠ Auto-aprovisionamiento: falló ${attempts} veces (último error: ${lastError}) — usar el botón manual.`;
}

export function watcherNoteConflict(sn: string): string {
  return `⚠ Auto-aprovisionamiento BLOQUEADO: el serial ${sn} está cargado en más de una tarea — resolver la ambigüedad y aprovisionar con el botón manual.`;
}

/** Counters del tick (REQ observabilidad: matched/provisioned/failed/skipped). */
export interface AutoProvisionFiberOnusSummary {
  /** Tareas con serial cargado y no archivadas. */
  candidates: number;
  /** ONUs sin configurar listadas (0 si el tick ni llamó al gateway). */
  unconfigured: number;
  /** Pares tarea↔ONU cuyo SN matcheó. */
  matched: number;
  provisioned: number;
  /** Intentos ejecutados que fallaron (transitorios o el 3ro definitivo). */
  failed: number;
  /** Matches NO intentados: backoff, estado terminal, sin contrato, conflicto. */
  skipped: number;
}

export interface AutoProvisionFiberOnusOptions {
  /**
   * Backoff entre reintentos de un mismo (taskId, onuSn). El bootstrap lo fija en
   * 2× el intervalo del tick → "no reintenta en el mismo tick ni el siguiente".
   */
  retryBackoffMs: number;
  /** Máximo de intentos (default 3). */
  maxAttempts?: number;
  /** Reloj inyectable — determinístico en tests. */
  now?: () => Date;
}

/**
 * K3 (fiber-auto-watcher) — núcleo del watcher full-auto de fibra.
 *
 * Por tick:
 *  1. Tareas candidatas (onuSerial seteado, NO archivadas) — consulta LOCAL primero:
 *     sin candidatas NO se llama a SmartOLT (respeta el rate limit 1000/h).
 *  2. UNA llamada a listUnconfiguredOnus → match EXACTO por SN canónico
 *     (case-insensitive vía normalizeOnuSerial en ambos lados).
 *  3. Por match, SECUENCIAL (rate limit + pausas del gateway):
 *     - Sin contrato → skip (sin contrato no hay a quién aprovisionar).
 *     - MISMO serial en 2+ tareas → conflicto: nota en AMBAS, status 'conflict',
 *       NO aprovisionar (ambigüedad = humano decide). Si el humano resuelve
 *       (limpia un serial) el watcher REANUDA la restante en el próximo tick.
 *     - Estado terminal previo (succeeded/failed-final/manual-required) → skip.
 *     - 'pending' dentro del backoff → skip (anti-martilleo).
 *     - Ejecuta ProvisionFiberOnu({contractId, onuSn, dryRun:false, origin:'watcher'}):
 *       el bloque auditable en la tarea lo escribe EL USE CASE (con la línea
 *       "(aprovisionada AUTOMÁTICAMENTE por el watcher)").
 *       · FIBER_VLAN_REQUIRED (CHIVILCOY) → nota única + 'manual-required', sin reintentos.
 *       · ONU_NOT_HUAWEI → nota única + 'manual-required', sin reintentos.
 *       · Otro error (transitorio) → attempts+1; al 3ro → nota + 'failed-final' y stop.
 *
 * Nota rate limit: cada ProvisionFiberOnu.execute re-lista unconfigured_onus (parte
 * del use case reusado tal cual, decisión K3) — el costo extra es 1 call POR MATCH
 * real, no por tick; los ticks sin matches hacen exactamente UNA llamada.
 */
export class AutoProvisionFiberOnus {
  private readonly maxAttempts: number;
  private readonly now: () => Date;

  constructor(
    private readonly taskRepo: FiberAutoProvisionTaskRepository,
    private readonly attemptRepo: FiberAutoProvisionAttemptRepository,
    private readonly gateway: OltProvisioningGateway,
    private readonly provisionFiberOnu: ProvisionFiberOnu,
    private readonly opts: AutoProvisionFiberOnusOptions,
  ) {
    this.maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
    this.now = opts.now ?? (() => new Date());
  }

  async run(): Promise<AutoProvisionFiberOnusSummary> {
    const summary: AutoProvisionFiberOnusSummary = {
      candidates: 0,
      unconfigured: 0,
      matched: 0,
      provisioned: 0,
      failed: 0,
      skipped: 0,
    };

    // 1. Local primero: sin candidatas no se quema NI UNA call del rate limit.
    const candidates = await this.taskRepo.listCandidates();
    summary.candidates = candidates.length;
    if (candidates.length === 0) return summary;

    // 2. UNA llamada de listado por tick.
    const onus = await this.gateway.listUnconfiguredOnus();
    summary.unconfigured = onus.length;
    if (onus.length === 0) return summary;

    const onuSns = new Set(onus.map(o => normalizeOnuSerial(o.sn)));

    // Matches agrupados por SN canónico — el grupo detecta el conflicto.
    const matchesBySn = new Map<string, FiberAutoProvisionCandidateTask[]>();
    for (const task of candidates) {
      const sn = normalizeOnuSerial(task.onuSerial);
      if (!onuSns.has(sn)) continue;
      const group = matchesBySn.get(sn) ?? [];
      group.push(task);
      matchesBySn.set(sn, group);
    }

    // 3. SECUENCIAL adrede: los provisions comparten el rate limit de SmartOLT y el
    //    gateway ya mete pausas entre calls — paralelizar acá lo rompería.
    for (const [sn, tasks] of matchesBySn) {
      summary.matched += tasks.length;

      // C1 (fix wave CRITICAL) — los pares (taskId, sn) en estado TERMINAL salen de
      // la ecuación ANTES del check de ambigüedad: el reuso legítimo de una ONU
      // (tarea vieja succeeded + tarea nueva con el mismo serial) NO es conflicto —
      // la nueva se aprovisiona y el estado terminal de la vieja queda INTOCABLE
      // (jamás pisado a 'conflict', que es reanudable).
      const active: FiberAutoProvisionCandidateTask[] = [];
      for (const task of tasks) {
        const record = await this.attemptRepo.find(task.id, sn);
        if (record && record.status !== 'pending' && record.status !== 'conflict') {
          summary.skipped++;
          continue;
        }
        active.push(task);
      }

      // M3 (fix wave) — la ambigüedad se evalúa sobre TODOS los matches ACTIVOS del
      // serial, con o sin contrato; el contractId se valida recién DESPUÉS.
      if (active.length > 1) {
        for (const task of active) {
          await this.markConflict(task, sn);
          summary.skipped++;
        }
        continue;
      }
      if (active.length === 0) continue;

      const task = active[0]!;
      if (task.contractId == null) {
        // Sin contrato no hay a quién aprovisionar — visible como skip.
        summary.skipped++;
        continue;
      }

      await this.processMatch(task, sn, summary);
    }

    return summary;
  }

  // ── Un match único (sin ambigüedad) ─────────────────────────────────────────

  private async processMatch(
    task: FiberAutoProvisionCandidateTask,
    sn: string,
    summary: AutoProvisionFiberOnusSummary,
  ): Promise<void> {
    const record = await this.attemptRepo.find(task.id, sn);

    // Defensa en profundidad: run() ya excluyó los terminales del grouping (C1);
    // 'conflict' NO es terminal — si el serial volvió a ser único, se reanuda acá.
    if (record && record.status !== 'pending' && record.status !== 'conflict') {
      summary.skipped++;
      return;
    }

    // Backoff persistido: no reintentar en el mismo tick ni el siguiente.
    if (record?.status === 'pending' && record.lastAttemptAt) {
      const elapsed = this.now().getTime() - Date.parse(record.lastAttemptAt);
      if (elapsed < this.opts.retryBackoffMs) {
        summary.skipped++;
        return;
      }
    }

    const attempts = (record?.attempts ?? 0) + 1;
    // L6 (fix wave) — WRITE-AHEAD: el intento se persiste ANTES del provision. Un
    // crash a mitad de la secuencia no pierde el intento — tras el restart el
    // backoff ya rige y el contador no se resetea.
    await this.saveAttempt(task.id, sn, attempts, 'pending', record?.lastError ?? null);

    try {
      await this.provisionFiberOnu.execute({
        contractId: task.contractId!,
        onuSn: sn,
        dryRun: false,
        origin: 'watcher',
        // M4 — el bloque auditable va a la tarea MATCHEADA por serial, no a
        // "la última del contrato" (que puede ser un reclamo posterior).
        auditTaskId: task.id,
      });
      summary.provisioned++;
      await this.saveAttempt(task.id, sn, attempts, 'succeeded', null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof UnconfiguredOnuNotFoundError) {
        // L8 (fix wave) — carrera con el wizard: la ONU dejó de estar unconfigured
        // entre NUESTRO listado y el provision. No es un fallo del par: se restaura
        // el registro previo (el write-ahead no cuenta como intento) y el próximo
        // tick ya ni matchea.
        summary.skipped++;
        await this.attemptRepo.save(
          record ?? { taskId: task.id, onuSn: sn, attempts: 0, status: 'pending', lastError: null, lastAttemptAt: null },
        );
      } else if (err instanceof FiberVlanRequiredError) {
        // CHIVILCOY: la VLAN es por cliente — el humano la elige SIEMPRE. Nunca auto.
        // L7 — el estado terminal se persiste ANTES de la nota (la nota es best-effort:
        // si falla se pierde, pero el estado ya impide duplicar provisiones).
        summary.skipped++;
        await this.saveAttempt(task.id, sn, attempts, 'manual-required', message);
        await this.appendNoteBestEffort(task.id, WATCHER_NOTE_VLAN_MANUAL);
      } else if (err instanceof OnuNotHuaweiError) {
        // El serial se registra igual (ZTE/VSOL), pero solo Huawei se auto-aprovisiona.
        summary.skipped++;
        await this.saveAttempt(task.id, sn, attempts, 'manual-required', message);
        await this.appendNoteBestEffort(task.id, WATCHER_NOTE_NON_HUAWEI);
      } else {
        // Transitorio (SmartOLT caído / rechazo puntual): backoff y hasta 3 intentos.
        summary.failed++;
        if (attempts >= this.maxAttempts) {
          await this.saveAttempt(task.id, sn, attempts, 'failed-final', message);
          await this.appendNoteBestEffort(task.id, watcherNoteFailedFinal(attempts, message));
        } else {
          await this.saveAttempt(task.id, sn, attempts, 'pending', message);
        }
      }
    }
  }

  // ── Conflicto (serial duplicado) ────────────────────────────────────────────

  private async markConflict(task: FiberAutoProvisionCandidateTask, sn: string): Promise<void> {
    const record = await this.attemptRepo.find(task.id, sn);
    // C1 — JAMÁS pisar un estado que no sea pending: 'conflict' ya tiene su nota
    // (única), y los terminales (succeeded/failed-final/manual-required) son
    // INTOCABLES — pisarlos a 'conflict' los volvería reanudables (el bug CRITICAL
    // del review: la ONU del cliente nuevo configurada con datos del viejo).
    if (record && record.status !== 'pending') return;
    // L7 — estado ANTES de la nota.
    await this.saveAttempt(task.id, sn, record?.attempts ?? 0, 'conflict', 'serial duplicado en más de una tarea');
    await this.appendNoteBestEffort(task.id, watcherNoteConflict(sn));
  }

  /** L7 — la nota es best-effort: si la DB falla escribiéndola, el tick NO explota
   *  (el estado ya quedó persistido; la nota se pierde, jamás se duplica un provision). */
  private async appendNoteBestEffort(taskId: string, note: string): Promise<void> {
    try {
      await this.taskRepo.appendNote(taskId, note);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[fiber-auto-watcher] no se pudo escribir la nota en la tarea (best-effort):', err);
    }
  }

  private async saveAttempt(
    taskId: string,
    onuSn: string,
    attempts: number,
    status: FiberAutoProvisionAttempt['status'],
    lastError: string | null,
  ): Promise<void> {
    await this.attemptRepo.save({
      taskId,
      onuSn,
      attempts,
      status,
      lastError,
      lastAttemptAt: this.now().toISOString(),
    });
  }
}
