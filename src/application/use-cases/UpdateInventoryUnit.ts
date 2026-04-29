import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { InventoryUnit } from '@domain/entities/empresa';

export class UpdateInventoryUnit {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string, data: Partial<InventoryUnit>): Promise<InventoryUnit | null> {
    return this.repo.updateInventoryUnit(id, data);
  }
}
