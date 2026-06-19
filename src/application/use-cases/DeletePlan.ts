import { PlanRepository } from '@domain/ports/PlanRepository';
import { RadiusOrchestratorGateway } from '@domain/ports/RadiusOrchestratorGateway';
import { PlanNotFoundError } from '@domain/errors/plan';

/**
 * DeletePlan — elimina un plan de la DB de Prominense y del radgroupreply del RADIUS.
 *
 * Orden de consistencia (orchestrator-first):
 *   1. Buscar la fila existente — 404 si no existe (sin efectos en RADIUS).
 *   2. Llamar `gateway.deletePlan(code)` — si falla, no se toca la DB.
 *   3. Eliminar la fila en la DB.
 *
 * Nota: el repo.delete() lanza PlanNotFoundError internamente, pero la búsqueda previa
 * garantiza que tengamos el `code` para el orchestrator antes de ir a la DB.
 */
export class DeletePlan {
  constructor(
    private readonly repo: PlanRepository,
    private readonly gateway: RadiusOrchestratorGateway,
  ) {}

  async execute(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new PlanNotFoundError(id);

    // Orchestrator PRIMERO — si falla, la excepción sube y no se toca la DB.
    await this.gateway.deletePlan(existing.code);

    await this.repo.delete(id);
  }
}
