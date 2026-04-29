import { RoleRepository } from '@domain/ports/RoleRepository';
import { AdminRole_Definition } from '@domain/entities/role';

export class CreateRole {
  constructor(private readonly repo: RoleRepository) {}

  execute(data: Omit<AdminRole_Definition, 'id'>): Promise<AdminRole_Definition> {
    return this.repo.create(data);
  }
}
