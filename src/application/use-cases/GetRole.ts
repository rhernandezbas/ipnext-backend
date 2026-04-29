import { RoleRepository } from '@domain/ports/RoleRepository';
import { AdminRole_Definition } from '@domain/entities/role';

export class GetRole {
  constructor(private readonly repo: RoleRepository) {}

  execute(id: string): Promise<AdminRole_Definition | null> {
    return this.repo.findById(id);
  }
}
