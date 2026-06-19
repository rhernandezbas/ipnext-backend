import { Plan } from '@domain/entities/plan';
import { PlanRepository } from '@domain/ports/PlanRepository';

export class ListPlans {
  constructor(private readonly repo: PlanRepository) {}
  async execute(): Promise<Plan[]> {
    return this.repo.list();
  }
}
