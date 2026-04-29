import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { InventoryUnit } from '@domain/entities/empresa';

export class ListInventoryUnits {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(productId?: string): Promise<InventoryUnit[]> {
    if (productId) {
      return this.repo.findInventoryUnitsByProductId(productId);
    }
    return this.repo.findAllInventoryUnits();
  }
}
