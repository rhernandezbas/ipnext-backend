/**
 * RbacPermissionRepository — domain port.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { RbacPermission, PermissionAction } from '../entities/rbac';

export interface RbacPermissionRepository {
  listAll(): Promise<RbacPermission[]>;
  findByModuleAndAction(moduleCode: string, action: PermissionAction): Promise<RbacPermission | null>;
}
