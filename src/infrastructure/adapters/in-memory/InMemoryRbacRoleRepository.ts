import { randomUUID } from 'crypto';
import type { RbacRole } from '@domain/entities/rbac';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';

interface CreateRoleInput {
  code: string;
  label: string;
  isSystem: boolean;
}

/**
 * InMemoryRbacRoleRepository — test seam for RbacRoleRepository.
 *
 * `create` is an extra helper method for seeding test data — it is NOT part
 * of the RbacRoleRepository port. Prisma seeds roles via migration SQL.
 */
export class InMemoryRbacRoleRepository implements RbacRoleRepository {
  private readonly store = new Map<string, RbacRole>();

  async findById(id: string): Promise<RbacRole | null> {
    const role = this.store.get(id);
    return role ? { ...role } : null;
  }

  async findByCode(code: string): Promise<RbacRole | null> {
    for (const role of this.store.values()) {
      if (role.code === code) return { ...role };
    }
    return null;
  }

  async listAll(): Promise<RbacRole[]> {
    return Array.from(this.store.values()).map(r => ({ ...r }));
  }

  /** Test helper — seeds a role. NOT part of RbacRoleRepository port. */
  async create(input: CreateRoleInput): Promise<RbacRole> {
    const role: RbacRole = {
      id: randomUUID(),
      code: input.code,
      label: input.label,
      isSystem: input.isSystem,
    };
    this.store.set(role.id, role);
    return { ...role };
  }
}
