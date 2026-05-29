import { randomUUID } from 'crypto';
import type {
  RbacPermission,
  RbacPermissionCatalogEntry,
  RbacModuleCode,
  PermissionAction,
} from '@domain/entities/rbac';
import type { RbacPermissionRepository } from '@domain/ports/RbacPermissionRepository';

interface SeedInput {
  moduleCode: RbacModuleCode;
  action: PermissionAction;
  /** Optional — defaults to a stable generated id per moduleCode. */
  moduleId?: string;
  /** Optional — defaults to the moduleCode when omitted. */
  moduleLabel?: string;
}

/**
 * InMemoryRbacPermissionRepository — test seam for RbacPermissionRepository.
 *
 * `seed` is an extra helper for tests — NOT part of the port. Prisma populates
 * permissions via the catalog migration SQL.
 */
export class InMemoryRbacPermissionRepository implements RbacPermissionRepository {
  private readonly store = new Map<string, RbacPermission>();
  private readonly moduleIds = new Map<string, string>();
  private readonly moduleLabels = new Map<string, string>();

  async listAll(): Promise<RbacPermission[]> {
    return Array.from(this.store.values()).map(p => ({ ...p }));
  }

  async listCatalog(): Promise<RbacPermissionCatalogEntry[]> {
    return Array.from(this.store.values()).map(p => ({
      id: p.id,
      moduleId: this.moduleIds.get(p.moduleCode) ?? p.moduleCode,
      moduleCode: p.moduleCode,
      moduleLabel: this.moduleLabels.get(p.moduleCode) ?? p.moduleCode,
      action: p.action,
    }));
  }

  async findByModuleAndAction(
    moduleCode: string,
    action: PermissionAction,
  ): Promise<RbacPermission | null> {
    for (const perm of this.store.values()) {
      if (perm.moduleCode === moduleCode && perm.action === action) {
        return { ...perm };
      }
    }
    return null;
  }

  /** Test helper — seeds a permission. NOT part of RbacPermissionRepository port. */
  async seed(input: SeedInput): Promise<RbacPermission> {
    if (!this.moduleIds.has(input.moduleCode)) {
      this.moduleIds.set(input.moduleCode, input.moduleId ?? randomUUID());
    }
    if (input.moduleLabel !== undefined) {
      this.moduleLabels.set(input.moduleCode, input.moduleLabel);
    }
    const perm: RbacPermission = {
      id: randomUUID(),
      moduleCode: input.moduleCode,
      action: input.action,
    };
    this.store.set(perm.id, perm);
    return { ...perm };
  }
}
