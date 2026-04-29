import { AdminRepository } from '@domain/ports/AdminRepository';
import { Admin } from '@domain/entities/admin';

export class UpdateAdmin {
  constructor(private readonly repo: AdminRepository) {}

  execute(id: string, data: Partial<Admin>): Promise<Admin | null> {
    return this.repo.update(id, data);
  }
}
