/**
 * RbacUserRoleRepository — domain port.
 *
 * Manages the many-to-many pivot between RbacUser and RbacRole.
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 */

export interface RbacUserRoleRepository {
  /** Idempotent — upsert semantics; no error if already assigned. */
  assign(userId: string, roleId: string): Promise<void>;

  revoke(userId: string, roleId: string): Promise<void>;

  /** Returns the role IDs assigned to the user. */
  listForUser(userId: string): Promise<string[]>;
}
