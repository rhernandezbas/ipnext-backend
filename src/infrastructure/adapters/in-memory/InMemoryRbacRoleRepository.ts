import { randomUUID } from 'crypto';
import type { RbacRole } from '@domain/entities/rbac';
import type { RbacRoleRepository, CreateRoleInput } from '@domain/ports/RbacRoleRepository';
import { RoleCodeTakenError } from '@domain/errors/rbacUser.errors';

/**
 * InMemoryRbacRoleRepository — test seam for RbacRoleRepository.
 *
 * Implements the full RbacRoleRepository port including create + delete.
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

  async create(input: CreateRoleInput): Promise<RbacRole> {
    // Check code uniqueness
    for (const role of this.store.values()) {
      if (role.code === input.code) {
        throw new RoleCodeTakenError(input.code);
      }
    }
    const role: RbacRole = {
      id: randomUUID(),
      code: input.code,
      label: input.label,
      isSystem: input.isSystem,
    };
    this.store.set(role.id, role);
    return { ...role };
  }

  async delete(id: string): Promise<boolean> {
    if (!this.store.has(id)) return false;
    this.store.delete(id);
    return true;
  }
}
