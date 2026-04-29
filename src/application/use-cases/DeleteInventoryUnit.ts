import { EmpresaRepository } from '@domain/ports/EmpresaRepository';

export class DeleteInventoryUnit {
  constructor(private readonly repo: EmpresaRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.deleteInventoryUnit(id);
  }
}
