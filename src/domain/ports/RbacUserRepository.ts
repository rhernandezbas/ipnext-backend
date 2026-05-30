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

/**
 * Patch input for update(). All fields are optional — only provided fields
 * are changed. passwordHash update is intentionally separate from the user-facing
 * fields to keep the audit surface clean, but for the port contract we allow
 * it here so the ChangeRbacUserPassword use case can route through a single call.
 */
export interface UpdateRbacUserInput {
  name?: string;
  email?: string;
  login?: string;
  status?: 'active' | 'disabled';
  passwordHash?: string;
  // SDD #6a — account lockout (auth-internal, not exposed on RbacUser)
  failedLoginCount?: number;
  lockedUntil?: Date | null;
}

/** Auth-internal fields returned only by findByLogin (like passwordHash). */
export interface RbacUserAuthFields {
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: string | null;
}

export interface RbacUserRepository {
  findById(id: string): Promise<RbacUser | null>;

  /** Returns the user record including passwordHash + lockout fields for auth flows. */
  findByLogin(login: string): Promise<(RbacUser & RbacUserAuthFields) | null>;

  findByEmail(email: string): Promise<RbacUser | null>;

  create(input: CreateRbacUserInput): Promise<RbacUser>;

  updateLastLogin(id: string, at: Date): Promise<void>;

  /** Hot path: resolves all roles for a user (used by middleware super_admin check). */
  listRolesForUser(userId: string): Promise<RbacRole[]>;

  /** Hot path: resolves full permission set for a user across all roles. */
  listPermissionsForUser(userId: string): Promise<RbacPermission[]>;

  // ---------------------------------------------------------------------------
  // SDD #2 additions — CRUD use cases
  // ---------------------------------------------------------------------------

  /** Returns all users (no pagination — admin pool is small, < 100). */
  list(): Promise<RbacUser[]>;

  /**
   * Partial update. Throws (rejects) if id does not exist.
   * Only provided fields are changed; omitted fields are left as-is.
   */
  update(id: string, patch: UpdateRbacUserInput): Promise<RbacUser>;

  /**
   * Deletes the user. Adapters MUST also remove all pivot rows (RbacUserRole).
   * The Prisma adapter relies on ON DELETE CASCADE from the SDD #1 migration;
   * if absent, it wraps in a $transaction.
   */
  delete(id: string): Promise<void>;

  /**
   * Counts distinct users who have at least one assigned role with the given
   * role code. Used by the last-super_admin guard.
   */
  countUsersWithRoleCode(roleCode: string): Promise<number>;
}
