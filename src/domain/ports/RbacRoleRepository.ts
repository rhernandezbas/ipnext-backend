/**
 * RbacRoleRepository — domain port.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { RbacRole } from '../entities/rbac';

export interface RbacRoleRepository {
  findById(id: string): Promise<RbacRole | null>;
  findByCode(code: string): Promise<RbacRole | null>;
  listAll(): Promise<RbacRole[]>;
}
