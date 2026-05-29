/**
 * RbacUserRepository — domain port.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 * Application and infrastructure layers depend on this interface, never the reverse.
 */
import type { RbacUser, RbacRole, RbacPermission } from '../entities/rbac';

export interface CreateRbacUserInput {
  name: string;
  email: string;
  login: string;
  passwordHash: string;
  status?: 'active' | 'disabled';
}

export interface RbacUserRepository {
  findById(id: string): Promise<RbacUser | null>;

  /** Returns the user record including passwordHash for authentication flows. */
  findByLogin(login: string): Promise<(RbacUser & { passwordHash: string }) | null>;

  findByEmail(email: string): Promise<RbacUser | null>;

  create(input: CreateRbacUserInput): Promise<RbacUser>;

  updateLastLogin(id: string, at: Date): Promise<void>;

  /** Hot path: resolves all roles for a user (used by middleware super_admin check). */
  listRolesForUser(userId: string): Promise<RbacRole[]>;

  /** Hot path: resolves full permission set for a user across all roles. */
  listPermissionsForUser(userId: string): Promise<RbacPermission[]>;
}
