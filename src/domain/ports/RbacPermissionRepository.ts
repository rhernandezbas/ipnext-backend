/**
 * RbacPermissionRepository — domain port.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { RbacPermission, RbacPermissionCatalogEntry, PermissionAction } from '../entities/rbac';

export interface RbacPermissionRepository {
  listAll(): Promise<RbacPermission[]>;
  /** Full catalog enriched with each module's id + display label (for the matrix UI). */
  listCatalog(): Promise<RbacPermissionCatalogEntry[]>;
  findByModuleAndAction(moduleCode: string, action: PermissionAction): Promise<RbacPermission | null>;
}
