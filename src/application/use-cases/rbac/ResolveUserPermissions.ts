/**
 * ResolveUserPermissions — use case.
 *
 * Returns the flat list of permission codes for a given user.
 *
 * Design decisions (AD-BE-2):
 * - super_admin sentinel: if ANY role has code === 'super_admin', returns ["*"]
 *   immediately WITHOUT evaluating any permission rows.
 * - Other users: union of all permissionId grants across roles, resolved to
 *   "{moduleCode}.{action}" codes, deduplicated, sorted.
 *
 * Note: super_admin permissions are NOT stored as DB rows — the ["*"] sentinel
 * comes purely from this in-memory logic. This is intentional; the migration
 * (Phase 2) will add rows for other roles, but super_admin remains sentinel-only.
 */
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { RbacRolePermissionRepository } from '@domain/ports/RbacRolePermissionRepository';
import type { RbacPermissionRepository } from '@domain/ports/RbacPermissionRepository';
import { DomainError } from '@domain/errors/index';

export class ResolveUserPermissions {
  constructor(
    private readonly userRoleRepo: RbacUserRoleRepository,
    private readonly rolePermRepo: RbacRolePermissionRepository,
    private readonly permRepo: RbacPermissionRepository,
  ) {}

  async execute(userId: string): Promise<string[]> {
    if (!userId || typeof userId !== 'string') {
      throw new DomainError('userId must be a non-empty string', 'INVALID_USER_ID');
    }

    // Resolve full role objects (code + id)
    const roles = await this.userRoleRepo.listRolesForUser(userId);

    // R1: super_admin short-circuit — no permission lookup performed
    if (roles.some((r) => r.code === 'super_admin')) {
      return ['*'];
    }

    // R3: no roles → empty
    if (roles.length === 0) {
      return [];
    }

    // R2: collect all permissionIds across roles
    const allPermissionIds = new Set<string>();
    for (const role of roles) {
      const permIds = await this.rolePermRepo.listForRole(role.id);
      for (const id of permIds) {
        allPermissionIds.add(id);
      }
    }

    // R4: no grants → empty
    if (allPermissionIds.size === 0) {
      return [];
    }

    // Resolve permission codes
    const allPerms = await this.permRepo.listAll();
    const permMap = new Map(allPerms.map((p) => [p.id, p]));

    // R5: deduplicate via Set (already done above), build code strings
    const codes = new Set<string>();
    for (const permId of allPermissionIds) {
      const perm = permMap.get(permId);
      if (perm) {
        codes.add(`${perm.moduleCode}.${perm.action}`);
      }
    }

    return Array.from(codes).sort();
  }
}
