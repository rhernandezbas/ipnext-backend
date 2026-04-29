import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { InventoryItem } from '@domain/entities/empresa';

export class UpdateInventoryItem {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string, data: Partial<InventoryItem>): Promise<InventoryItem | null> {
    return this.repo.updateInventoryItem(id, data);
  }
}
