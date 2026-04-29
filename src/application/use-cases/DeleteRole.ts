import { RoleRepository } from '@domain/ports/RoleRepository';

export class DeleteRole {
  constructor(private readonly repo: RoleRepository) {}

  execute(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
