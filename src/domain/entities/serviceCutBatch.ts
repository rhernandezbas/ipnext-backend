import { EnforcementAction } from './pppoeService';

/**
 * ServiceCutBatch (Fase C) — estado de un job de corte MASIVO on-demand.
 *
 * Persiste progreso (poleable) + resultado por-item (auditoría) + permite resumir.
 * NO hay scheduler: cada batch lo dispara el operador (POST). Un solo batch a la vez
 * (lock distribuido en el runner).
 */

export type ServiceCutBatchStatus = 'pending' | 'running' | 'done' | 'failed';

/** Resultado por PPPoE dentro del batch. */
export interface ServiceCutItemResult {
  pppoeId: string;
  ok: boolean;
  error?: string;
}

export interface ServiceCutBatch {
  id: string;
  action: EnforcementAction;
  status: ServiceCutBatchStatus;
  total: number;
  doneCount: number;        // items aplicados OK
  failedCount: number;      // items que fallaron (best-effort: no abortan el lote)
  result: ServiceCutItemResult[];
  createdAt: string;
  finishedAt: string | null;
}
