import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { InventoryItem } from '@domain/entities/empresa';

export class CreateInventoryItem {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(data: Omit<InventoryItem, 'id'>): Promise<InventoryItem> {
    return this.repo.createInventoryItem(data);
  }
}
