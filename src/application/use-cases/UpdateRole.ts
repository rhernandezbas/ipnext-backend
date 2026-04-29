import { RoleRepository } from '@domain/ports/RoleRepository';
import { AdminRole_Definition } from '@domain/entities/role';

export class UpdateRole {
  constructor(private readonly repo: RoleRepository) {}

  execute(id: string, data: Partial<AdminRole_Definition>): Promise<AdminRole_Definition | null> {
    return this.repo.update(id, data);
  }
}
