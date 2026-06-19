import { randomUUID } from 'crypto';
import type { RbacUser, RbacRole, RbacPermission } from '@domain/entities/rbac';
import type {
  CreateRbacUserInput,
  UpdateRbacUserInput,
  RbacUserRepository,
  RbacUserWithTeam,
} from '@domain/ports/RbacUserRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import type { IClassTeamRepository } from '@domain/ports/IClassTeamRepository';

interface StoredUser {
  user: RbacUser;
  passwordHash: string;
  lastLoginAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  iclassTeamLogin: string | null;
  grVendedorName: string | null;
}

/**
 * InMemoryRbacUserRepository — test seam for RbacUserRepository.
 *
 * Stores users in a plain Map. No external dependencies.
 *
 * For SDD #2 extensions:
 * - `userRoleRepo` (optional): required for `countUsersWithRoleCode` —
 *   used to look up which role IDs are assigned to each user.
 * - `roleRepo` (optional): required for `countUsersWithRoleCode` —
 *   used to resolve role code from role ID.
 *
 * listRolesForUser and listPermissionsForUser return empty arrays when no
 * repos are injected — they are resolved by the middleware through separate
 * pivot repos in production.
 */
export class InMemoryRbacUserRepository implements RbacUserRepository {
  private readonly store = new Map<string, StoredUser>();

  constructor(
    private readonly userRoleRepo?: RbacUserRoleRepository,
    private readonly roleRepo?: RbacRoleRepository,
    /** Optional — required only for listWithIClassTeam. Tests that don't use it can omit. */
    private readonly teamRepo?: IClassTeamRepository,
  ) {}

  async findById(id: string): Promise<RbacUser | null> {
    const entry = this.store.get(id);
    if (!entry) return null;
    return {
      ...entry.user,
      iclassTeamLogin: entry.iclassTeamLogin,
      grVendedorName: entry.grVendedorName,
      lastLoginAt: entry.lastLoginAt ? entry.lastLoginAt.toISOString() : null,
    };
  }

  async findByLogin(login: string): Promise<(RbacUser & { passwordHash: string; failedLoginCount: number; lockedUntil: string | null }) | null> {
    for (const entry of this.store.values()) {
      if (entry.user.login === login) {
        return {
          ...entry.user,
          iclassTeamLogin: entry.iclassTeamLogin,
          grVendedorName: entry.grVendedorName,
          lastLoginAt: entry.lastLoginAt ? entry.lastLoginAt.toISOString() : null,
          passwordHash: entry.passwordHash,
          failedLoginCount: entry.failedLoginCount,
          lockedUntil: entry.lockedUntil ? entry.lockedUntil.toISOString() : null,
        };
      }
    }
    return null;
  }

  async findByEmail(email: string): Promise<RbacUser | null> {
    for (const entry of this.store.values()) {
      if (entry.user.email === email) {
        return {
          ...entry.user,
          lastLoginAt: entry.lastLoginAt ? entry.lastLoginAt.toISOString() : null,
        };
      }
    }
    return null;
  }

  async create(input: CreateRbacUserInput): Promise<RbacUser> {
    const now = new Date().toISOString();
    const user: RbacUser = {
      id: randomUUID(),
      name: input.name,
      email: input.email,
      login: input.login,
      status: input.status ?? 'active',
      iclassTeamLogin: null,
      grVendedorName: null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    this.store.set(user.id, { user, passwordHash: input.passwordHash, lastLoginAt: null, failedLoginCount: 0, lockedUntil: null, iclassTeamLogin: null, grVendedorName: null });
    return { ...user };
  }

  async updateLastLogin(id: string, at: Date): Promise<void> {
    const entry = this.store.get(id);
    if (!entry) return; // no-op for non-existent id (matches Prisma P2025 behavior)
    entry.lastLoginAt = at;
  }

  async listRolesForUser(_userId: string): Promise<RbacRole[]> {
    return [];
  }

  async listPermissionsForUser(_userId: string): Promise<RbacPermission[]> {
    return [];
  }

  // ---------------------------------------------------------------------------
  // SDD #2 additions
  // ---------------------------------------------------------------------------

  async list(): Promise<RbacUser[]> {
    return Array.from(this.store.values()).map(entry => ({
      ...entry.user,
      iclassTeamLogin: entry.iclassTeamLogin,
      grVendedorName: entry.grVendedorName,
      lastLoginAt: entry.lastLoginAt ? entry.lastLoginAt.toISOString() : null,
    }));
  }

  async listWithIClassTeam(): Promise<RbacUserWithTeam[]> {
    const result: RbacUserWithTeam[] = [];
    for (const entry of this.store.values()) {
      const login = entry.iclassTeamLogin;
      let teamName: string | null = null;
      let teamActive = false;
      if (login && this.teamRepo) {
        const team = await this.teamRepo.getByLogin(login);
        if (team) {
          teamName = team.name;
          teamActive = team.active;
        }
      }
      result.push({
        ...entry.user,
        iclassTeamLogin: login,
        grVendedorName: entry.grVendedorName,
        lastLoginAt: entry.lastLoginAt ? entry.lastLoginAt.toISOString() : null,
        teamName,
        teamActive,
      });
    }
    return result;
  }

  async update(id: string, patch: UpdateRbacUserInput): Promise<RbacUser> {
    const entry = this.store.get(id);
    if (!entry) {
      throw new Error(`RbacUser not found: ${id}`);
    }
    const now = new Date().toISOString();
    // Apply scalar field patches
    if (patch.name !== undefined) entry.user.name = patch.name;
    if (patch.email !== undefined) entry.user.email = patch.email;
    if (patch.login !== undefined) entry.user.login = patch.login;
    if (patch.status !== undefined) entry.user.status = patch.status;
    entry.user.updatedAt = now;
    // Apply passwordHash patch (stored separately from the user entity)
    if (patch.passwordHash !== undefined) {
      entry.passwordHash = patch.passwordHash;
    }
    // SDD #6a — lockout fields (auth-internal)
    if (patch.failedLoginCount !== undefined) {
      entry.failedLoginCount = patch.failedLoginCount;
    }
    if (patch.lockedUntil !== undefined) {
      entry.lockedUntil = patch.lockedUntil;
    }
    // AD-1 — iclassTeamLogin (soft FK, nullable, undefined = no change)
    if ('iclassTeamLogin' in patch) {
      entry.iclassTeamLogin = patch.iclassTeamLogin ?? null;
      entry.user.iclassTeamLogin = patch.iclassTeamLogin ?? null;
    }
    // Mis clientes (Fase 2) — grVendedorName (soft mapping, nullable, undefined = no change)
    if ('grVendedorName' in patch) {
      entry.grVendedorName = patch.grVendedorName ?? null;
      entry.user.grVendedorName = patch.grVendedorName ?? null;
    }
    return {
      ...entry.user,
      iclassTeamLogin: entry.iclassTeamLogin,
      grVendedorName: entry.grVendedorName,
      lastLoginAt: entry.lastLoginAt ? entry.lastLoginAt.toISOString() : null,
    };
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
    // Pivot rows are managed by the userRoleRepo — the InMemory adapter does
    // not cascade because the pivot repo is injected separately. In production
    // (Prisma), ON DELETE CASCADE handles this at the DB level.
  }

  /**
   * Counts distinct users who have at least one role with the given code.
   *
   * Requires both `userRoleRepo` and `roleRepo` to be injected. If they are
   * not present (legacy construction without these deps), returns 0 — this
   * ensures backwards compatibility with existing test setups that don't need
   * this method.
   */
  async countUsersWithRoleCode(roleCode: string): Promise<number> {
    if (!this.userRoleRepo || !this.roleRepo) {
      return 0;
    }
    let count = 0;
    for (const entry of this.store.values()) {
      const roleIds = await this.userRoleRepo.listForUser(entry.user.id);
      for (const roleId of roleIds) {
        const role = await this.roleRepo.findById(roleId);
        if (role && role.code === roleCode) {
          count++;
          break; // count this user once even if they have multiple matching roles
        }
      }
    }
    return count;
  }
}
