import { Plan } from '@domain/entities/plan';
import { PlanRepository } from '@domain/ports/PlanRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { PlanCodeTakenError } from '@domain/errors/plan';

export interface CreatePlanInput {
  code: string;
  name: string;
  category: string;
  downloadKbps: number;
  uploadKbps: number;
  pool?: string | null;
  status?: string;
}

/**
 * CreatePlan — crea un plan en la DB de Prominense y lo sincroniza con el radgroupreply del RADIUS.
 *
 * Orden de consistencia (orchestrator-first):
 *   1. Validar unicidad del código (404-guard temprana, sin efectos).
 *   2. Llamar `gateway.syncPlan(...)` — si falla, propaga excepción sin tocar la DB.
 *   3. Crear la fila en la DB — solo si el orchestrator confirmó.
 *
 * Resultado: ni un plan en RADIUS sin fila local, ni una fila local sin RADIUS.
 */
export class CreatePlan {
  constructor(
    private readonly repo: PlanRepository,
    private readonly gateway: RadiusOrchestratorGateway,
  ) {}

  async execute(input: CreatePlanInput): Promise<Plan> {
    const dup = await this.repo.findByCode(input.code);
    if (dup) throw new PlanCodeTakenError(input.code);

    // Orchestrator PRIMERO — si falla, la excepción sube y no se toca la DB.
    await this.gateway.syncPlan(input.code, input.downloadKbps, input.uploadKbps, input.pool ?? null);

    return this.repo.upsertByCode(input);
  }
}
