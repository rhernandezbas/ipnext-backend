import { Plan } from '@domain/entities/plan';
import { PlanRepository } from '@domain/ports/PlanRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { PlanNotFoundError } from '@domain/errors/plan';

export interface UpdatePlanInput {
  id: string;
  name?: string;
  category?: string;
  downloadKbps?: number;
  uploadKbps?: number;
  pool?: string | null;
  status?: string;
}

/**
 * UpdatePlan — actualiza un plan en la DB de Prominense y sincroniza el radgroupreply del RADIUS.
 *
 * Orden de consistencia (orchestrator-first):
 *   1. Buscar la fila existente — 404 si no existe (sin efectos en RADIUS).
 *   2. Calcular los valores finales (merge existing + input).
 *   3. Llamar `gateway.syncPlan(...)` con los valores FINALES — si falla, no se toca la DB.
 *   4. Actualizar la fila en la DB.
 */
export class UpdatePlan {
  constructor(
    private readonly repo: PlanRepository,
    private readonly gateway: RadiusOrchestratorGateway,
  ) {}

  async execute(input: UpdatePlanInput): Promise<Plan> {
    const existing = await this.repo.findById(input.id);
    if (!existing) throw new PlanNotFoundError(input.id);

    // Valores finales después del merge (los que quedarán en RADIUS y en DB).
    const finalDownload = input.downloadKbps ?? existing.downloadKbps;
    const finalUpload   = input.uploadKbps   ?? existing.uploadKbps;
    const finalPool     = 'pool' in input ? (input.pool ?? null) : null;

    // Orchestrator PRIMERO — si falla, la excepción sube y no se toca la DB.
    await this.gateway.syncPlan(existing.code, finalDownload, finalUpload, finalPool);

    return this.repo.upsertByCode({ ...existing, ...input });
  }
}
