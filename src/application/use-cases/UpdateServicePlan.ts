import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { ServicePlan } from '@domain/entities/empresa';

export class UpdateServicePlan {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string, data: Partial<ServicePlan>): Promise<ServicePlan | null> {
    return this.repo.updateServicePlan(id, data);
  }
}
