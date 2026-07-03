/**
 * UserRoleLookup — domain port.
 *
 * Resolves the RBAC role CODES a user carries (e.g. ['ventas', 'noc']). Kept
 * intentionally minimal — role *codes* only, no labels/ids — so use cases can
 * reason about the assignee pool without pulling in the full RbacUserRepository.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or Prisma.
 * The infrastructure wiring (app.ts) satisfies it by mapping
 * RbacUserRepository.listRolesForUser(id) → roles.map(r => r.code).
 */
export interface UserRoleLookup {
  /** Returns every role code assigned to the user; [] when the user has none. */
  listRoleCodes(userId: string): Promise<string[]>;
}
