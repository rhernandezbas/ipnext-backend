/**
 * CreateRbacRole — create a new custom RBAC role.
 *
 * Validates code format and label length, then delegates to the repo.
 * isSystem is always false for roles created via this use case.
 */
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import type { RbacRole } from '@domain/entities/rbac';
import { RoleValidationError } from '@domain/errors/rbacUser.errors';

const CODE_REGEX = /^[a-z][a-z0-9_]{1,39}$/;

export interface CreateRbacRoleInput {
  code: string;
  label: string;
  description?: string | null;
}

export class CreateRbacRole {
  constructor(private readonly roleRepo: RbacRoleRepository) {}

  async execute(input: CreateRbacRoleInput): Promise<RbacRole> {
    const code = (input.code ?? '').trim();
    const label = (input.label ?? '').trim();

    if (!CODE_REGEX.test(code)) {
      throw new RoleValidationError(
        'code must be 2-40 characters, start with a lowercase letter, and contain only lowercase letters, digits, or underscores',
      );
    }

    if (label.length < 2 || label.length > 100) {
      throw new RoleValidationError('label must be between 2 and 100 characters');
    }

    return this.roleRepo.create({
      code,
      label,
      description: input.description ?? null,
      isSystem: false,
    });
  }
}
