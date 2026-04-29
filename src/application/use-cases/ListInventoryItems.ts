import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { InventoryItem } from '@domain/entities/empresa';

export class ListInventoryItems {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(): Promise<InventoryItem[]> {
    return this.repo.findAllInventoryItems();
  }
}
