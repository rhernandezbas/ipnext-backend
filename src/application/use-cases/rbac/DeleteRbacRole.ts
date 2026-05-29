/**
 * DeleteRbacRole — delete a custom RBAC role.
 *
 * Guards:
 *   - Role must exist (RoleNotFoundError)
 *   - System roles cannot be deleted (RoleIsSystemError)
 */
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import { RoleNotFoundError, RoleIsSystemError } from '@domain/errors/rbacUser.errors';

export class DeleteRbacRole {
  constructor(private readonly roleRepo: RbacRoleRepository) {}

  async execute(id: string): Promise<void> {
    const role = await this.roleRepo.findById(id);
    if (!role) throw new RoleNotFoundError(id);
    if (role.isSystem) throw new RoleIsSystemError(id);
    await this.roleRepo.delete(id);
  }
}
