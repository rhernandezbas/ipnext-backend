import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { InventoryItem } from '@domain/entities/empresa';

export class GetInventoryItem {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string): Promise<InventoryItem | null> {
    return this.repo.findInventoryItemById(id);
  }
}
