import { RoleRepository } from '@domain/ports/RoleRepository';
import { AdminRole_Definition } from '@domain/entities/role';

export class ListRoles {
  constructor(private readonly repo: RoleRepository) {}

  execute(): Promise<AdminRole_Definition[]> {
    return this.repo.findAll();
  }
}
