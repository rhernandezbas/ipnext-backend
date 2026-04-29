import { AdminRepository } from '@domain/ports/AdminRepository';
import { Admin } from '@domain/entities/admin';

export class CreateAdmin {
  constructor(private readonly repo: AdminRepository) {}

  execute(data: Omit<Admin, 'id' | 'createdAt' | 'lastLogin'>): Promise<Admin> {
    return this.repo.create(data);
  }
}
