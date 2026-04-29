import { EmpresaRepository } from '@domain/ports/EmpresaRepository';

export class DeleteInventoryProduct {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.deleteInventoryProduct(id);
  }
}
