import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { ServicePlan } from '@domain/entities/empresa';

export class ListServicePlans {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(subtype?: string): Promise<ServicePlan[]> {
    return this.repo.findAllServicePlans(subtype);
  }
}
