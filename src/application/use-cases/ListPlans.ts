import { Plan } from '@domain/entities/plan';
import { PlanRepository } from '@domain/ports/PlanRepository';
import { planOrderComparator } from '@application/utils/naturalSort';

export class ListPlans {
  constructor(private readonly repo: PlanRepository) {}
  async execute(): Promise<Plan[]> {
    const plans = await this.repo.list();
    // Copia antes de ordenar: el array del repo no se muta.
    // El orden del catálogo es responsabilidad de ESTE use case (el port no garantiza orden).
    return [...plans].sort(planOrderComparator);
  }
}
