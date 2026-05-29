/**
 * RbacRoleRepository — domain port.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */
import type { RbacRole } from '../entities/rbac';

export interface CreateRoleInput {
  code: string;
  label: string;
  description?: string | null;
  isSystem: boolean;
}

export interface RbacRoleRepository {
  findById(id: string): Promise<RbacRole | null>;
  findByCode(code: string): Promise<RbacRole | null>;
  listAll(): Promise<RbacRole[]>;
  create(input: CreateRoleInput): Promise<RbacRole>;
  delete(id: string): Promise<boolean>;
}
