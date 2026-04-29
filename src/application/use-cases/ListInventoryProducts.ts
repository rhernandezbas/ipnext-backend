import { EmpresaRepository } from '@domain/ports/EmpresaRepository';
import { InventoryProduct } from '@domain/entities/empresa';

export class ListInventoryProducts {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(): Promise<InventoryProduct[]> {
    return this.repo.findAllInventoryProducts();
  }
}
