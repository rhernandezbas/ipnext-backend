import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { InventoryProduct } from '@domain/entities/empresa';

export class UpdateInventoryProduct {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string, data: Partial<InventoryProduct>): Promise<InventoryProduct | null> {
    return this.repo.updateInventoryProduct(id, data);
  }
}
