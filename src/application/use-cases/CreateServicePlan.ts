import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { ServicePlan } from '@domain/entities/empresa';

export class CreateServicePlan {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(data: Omit<ServicePlan, 'id'>): Promise<ServicePlan> {
    return this.repo.createServicePlan(data);
  }
}
