import { AdminRepository } from '@domain/ports/AdminRepository';
import { Admin } from '@domain/entities/admin';

export class GetAdmin {
  constructor(private readonly repo: AdminRepository) {}

  execute(id: string): Promise<Admin | null> {
    return this.repo.findById(id);
  }
}
