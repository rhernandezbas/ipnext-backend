import {
  ServiceCutBatch,
  ServiceCutBatchStatus,
  ServiceCutItemResult,
} from '../entities/serviceCutBatch';
import { EnforcementAction } from '../entities/pppoeService';

export interface ServiceCutBatchCreate {
  action: EnforcementAction;
  total: number;
}

/** Campos mutables del batch durante su corrida (last-write-wins; snapshot completo). */
export interface ServiceCutBatchPatch {
  status?: ServiceCutBatchStatus;
  doneCount?: number;
  failedCount?: number;
  result?: ServiceCutItemResult[];
  finishedAt?: string | null;
}

export interface ServiceCutBatchRepository {
  /** Crea el batch en estado 'pending' (total = cantidad de items a procesar). */
  create(data: ServiceCutBatchCreate): Promise<ServiceCutBatch>;
  findById(id: string): Promise<ServiceCutBatch | null>;
  /** Actualiza progreso/estado (snapshot completo de los campos provistos). */
  update(id: string, patch: ServiceCutBatchPatch): Promise<ServiceCutBatch>;
}
