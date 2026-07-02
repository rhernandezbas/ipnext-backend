import { PppoeService, EnforcementAction } from '@domain/entities/pppoeService';
import { PppoeServiceRepository } from '@domain/ports/PppoeServiceRepository';
import { ServiceCutBatch, ServiceCutItemResult } from '@domain/entities/serviceCutBatch';
import { ServiceCutBatchRepository } from '@domain/ports/ServiceCutBatchRepository';
import { mapWithConcurrency } from '@application/util/mapWithConcurrency';
import { EnforcePppoeService } from './EnforcePppoeService';

export interface RunBulkEnforcementInput {
  batchId: string;
  action: EnforcementAction;
  pppoeIds: string[];
}

export interface RunBulkEnforcementOptions {
  /** Throttle entre operaciones del MISMO router (resiliencia > velocidad). */
  sleep?: (ms: number) => Promise<void>;
  throttleMs?: number;
  /** Cuántos routers procesar en paralelo (1 carril por router). */
  routerConcurrency?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * RunBulkEnforcement (Fase C) — ejecuta un corte MASIVO sobre una lista de PPPoE.
 *
 * Estrategia (no sobrecargar los maestros): **agrupa por router** → cada router es un carril
 * SERIAL (una op por vez), y se procesan N routers EN PARALELO (`mapWithConcurrency`). Entre
 * operaciones del mismo router hay un `throttle` configurable. **Best-effort**: si un item falla
 * (router caído, pppoe inexistente) queda `failed` y el lote SIGUE. Reusa `EnforcePppoeService`
 * (idempotente → re-correr el batch no reprocesa lo ya hecho: resumible).
 *
 * Progreso persistido en `ServiceCutBatch` tras cada item (snapshot completo del estado local →
 * sin race de increments entre los carriles paralelos; last-write-wins con el snapshot íntegro).
 */
export class RunBulkEnforcement {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly throttleMs: number;
  private readonly routerConcurrency: number;

  constructor(
    private readonly repo: PppoeServiceRepository,
    private readonly enforce: EnforcePppoeService,
    private readonly batchRepo: ServiceCutBatchRepository,
    opts?: RunBulkEnforcementOptions,
  ) {
    this.sleep = opts?.sleep ?? defaultSleep;
    this.throttleMs = opts?.throttleMs ?? 300;
    this.routerConcurrency = opts?.routerConcurrency ?? 16;
  }

  async execute(input: RunBulkEnforcementInput): Promise<ServiceCutBatch> {
    const { batchId, action, pppoeIds } = input;

    // 1) Resolver filas + agrupar por router. Los ids inexistentes → failed up-front.
    const groups = new Map<string, PppoeService[]>();
    const results: ServiceCutItemResult[] = [];
    let done = 0;
    let failed = 0;

    for (const id of pppoeIds) {
      const s = await this.repo.findById(id);
      if (!s) {
        results.push({ pppoeId: id, ok: false, error: 'PPPOE_NOT_FOUND' });
        failed++;
        continue;
      }
      // pppoe-preprovision (REQ-PRE-4): un PENDIENTE de instalación (nasId null) no es cortable
      // — failed tipado up-front (defensa en profundidad: resolveEnforcementCandidates ya lo
      // excluye en el camino HTTP, pero un caller directo no pasa por ahí).
      const nasId = s.nasId;
      if (nasId === null) {
        results.push({ pppoeId: id, ok: false, error: 'PPPOE_PENDING_INSTALL' });
        failed++;
        continue;
      }
      const list = groups.get(nasId);
      if (list) list.push(s);
      else groups.set(nasId, [s]);
    }

    // Writer de progreso COALESCED + SERIAL + best-effort:
    //  - un solo write en vuelo (los carriles paralelos NO pisan snapshots entre sí);
    //  - coalescing: varios pedidos durante un write colapsan en UN write del último estado vivo
    //    (evita el O(n²) de reescribir la fila/JSON en cada uno de miles de items);
    //  - best-effort: un fallo al persistir progreso NUNCA aborta el corte (try/catch interno).
    //    Por eso el progreso NO se hace en el await del carril → un hipo de DB no tumba el lote.
    let pending = false;
    let inFlight: Promise<void> | null = null;
    const drain = async (): Promise<void> => {
      while (pending) {
        pending = false;
        const snapshot = { doneCount: done, failedCount: failed, result: results.slice() };
        try {
          await this.batchRepo.update(batchId, snapshot);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[RunBulkEnforcement] progress write failed (best-effort):', err instanceof Error ? err.message : err);
        }
      }
      inFlight = null;
    };
    const scheduleProgress = (): void => {
      pending = true;
      if (!inFlight) inFlight = drain();
    };

    // Marcar 'running' es best-effort: si falla, el corte igual procede y el write terminal manda.
    try {
      await this.batchRepo.update(batchId, { status: 'running', doneCount: done, failedCount: failed, result: results.slice() });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[RunBulkEnforcement] running marker failed (best-effort):', err instanceof Error ? err.message : err);
    }

    // 2) Procesar: N routers en paralelo, cada router SERIAL con throttle entre ops.
    const routers = [...groups.keys()];
    await mapWithConcurrency(routers, this.routerConcurrency, async (nasId) => {
      const list = groups.get(nasId)!;
      for (const s of list) {
        try {
          await this.enforce.execute({ id: s.id, action });
          results.push({ pppoeId: s.id, ok: true });
          done++;
        } catch (err) {
          results.push({ pppoeId: s.id, ok: false, error: err instanceof Error ? err.message : String(err) });
          failed++;
        }
        scheduleProgress(); // best-effort, no bloquea el carril ni puede abortarlo
        if (this.throttleMs > 0) await this.sleep(this.throttleMs); // throttle: no sobrecargar el maestro
      }
    });

    // Drenar el último progreso pendiente antes del cierre.
    if (inFlight) await inFlight;

    // 3) Cierre (estado terminal: snapshot completo y autoritativo).
    return this.batchRepo.update(batchId, {
      status: 'done',
      doneCount: done,
      failedCount: failed,
      result: results.slice(),
      finishedAt: new Date().toISOString(),
    });
  }
}
