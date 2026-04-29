import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { InventoryUnit } from '@domain/entities/empresa';

export class CreateInventoryUnit {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(data: Omit<InventoryUnit, 'id'>): Promise<InventoryUnit> {
    return this.repo.createInventoryUnit(data);
  }
}
