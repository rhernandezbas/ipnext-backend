import { AdminRepository } from '@domain/ports/AdminRepository';
import { Admin } from '@domain/entities/admin';

export class ListAdmins {
  constructor(private readonly repo: AdminRepository) {}

  execute(): Promise<Admin[]> {
    return this.repo.findAll();
  }
}
