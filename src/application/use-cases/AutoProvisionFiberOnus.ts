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
import { FiberVlanRequiredError, OnuNotHuaweiError } from '@domain/errors/smartolt';
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

      // Sin contrato no hay a quién aprovisionar — visible como skip.
      const provisionable = tasks.filter(t => t.contractId != null);
      summary.skipped += tasks.length - provisionable.length;

      if (provisionable.length > 1) {
        // Conflicto: el MISMO serial en 2+ tareas → nota en ambas, jamás aprovisionar.
        for (const task of provisionable) {
          await this.markConflict(task, sn);
          summary.skipped++;
        }
        continue;
      }
      if (provisionable.length === 0) continue;

      await this.processMatch(provisionable[0]!, sn, summary);
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

    // Estados terminales: no insistir jamás. 'conflict' NO es terminal: si el serial
    // volvió a ser único (el humano resolvió), se reanuda acá mismo.
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

    const priorAttempts = record?.attempts ?? 0;
    try {
      await this.provisionFiberOnu.execute({
        contractId: task.contractId!,
        onuSn: sn,
        dryRun: false,
        origin: 'watcher',
      });
      summary.provisioned++;
      await this.saveAttempt(task.id, sn, priorAttempts + 1, 'succeeded', null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof FiberVlanRequiredError) {
        // CHIVILCOY: la VLAN es por cliente — el humano la elige SIEMPRE. Nunca auto.
        summary.skipped++;
        await this.taskRepo.appendNote(task.id, WATCHER_NOTE_VLAN_MANUAL);
        await this.saveAttempt(task.id, sn, priorAttempts, 'manual-required', message);
      } else if (err instanceof OnuNotHuaweiError) {
        // El serial se registra igual (ZTE/VSOL), pero solo Huawei se auto-aprovisiona.
        summary.skipped++;
        await this.taskRepo.appendNote(task.id, WATCHER_NOTE_NON_HUAWEI);
        await this.saveAttempt(task.id, sn, priorAttempts, 'manual-required', message);
      } else {
        // Transitorio (SmartOLT caído / rechazo puntual): backoff y hasta 3 intentos.
        summary.failed++;
        const attempts = priorAttempts + 1;
        if (attempts >= this.maxAttempts) {
          await this.taskRepo.appendNote(task.id, watcherNoteFailedFinal(attempts, message));
          await this.saveAttempt(task.id, sn, attempts, 'failed-final', message);
        } else {
          await this.saveAttempt(task.id, sn, attempts, 'pending', message);
        }
      }
    }
  }

  // ── Conflicto (serial duplicado) ────────────────────────────────────────────

  private async markConflict(task: FiberAutoProvisionCandidateTask, sn: string): Promise<void> {
    const record = await this.attemptRepo.find(task.id, sn);
    // Nota ÚNICA: ya marcado conflict → no repetir la nota en cada tick.
    if (record?.status === 'conflict') return;
    await this.taskRepo.appendNote(task.id, watcherNoteConflict(sn));
    await this.saveAttempt(task.id, sn, record?.attempts ?? 0, 'conflict', 'serial duplicado en más de una tarea');
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
