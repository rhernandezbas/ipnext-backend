import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { ServicePlan } from '@domain/entities/empresa';

export class GetServicePlan {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string): Promise<ServicePlan | null> {
    return this.repo.findServicePlanById(id);
  }
}
