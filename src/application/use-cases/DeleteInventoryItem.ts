import { EmpresaRepository } from '@domain/ports/EmpresaRepository';

export class DeleteInventoryItem {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.deleteInventoryItem(id);
  }
}
