/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * NOTE: Uses `as any` casts on Prisma client calls because prisma generate
 * has not been run against the RBAC schema in this environment (no DB available).
 * The casts become unnecessary once the migration is applied and
 * `npm run prisma:generate` is executed. Runtime behavior IS correct.
 */
import { prisma } from '@infrastructure/database/prisma';
import type { RbacUser, RbacRole, RbacPermission } from '@domain/entities/rbac';
import type {
  CreateRbacUserInput,
  UpdateRbacUserInput,
  RbacUserRepository,
  RbacUserWithTeam,
} from '@domain/ports/RbacUserRepository';

type RbacUserRow = {
  id: string;
  name: string;
  email: string;
  login: string;
  passwordHash: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  /** AD-1: nullable soft FK to IClassTeam.login. Added by migration 20260727000000. */
  iclassTeamLogin?: string | null;
};

type RoleRow = {
  id: string;
  code: string;
  label: string;
  isSystem: boolean;
};

type PermissionRow = {
  id: string;
  action: string;
  module: { code: string };
};

type UserWithRolesAndPerms = RbacUserRow & {
  roles: Array<{ role: RoleRow & { permissions: Array<{ permission: PermissionRow }> } }>;
};

function mapUser(row: RbacUserRow): RbacUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    login: row.login,
    status: (row.status === 'active' || row.status === 'disabled') ? row.status : 'active',
    iclassTeamLogin: row.iclassTeamLogin ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  };
}

function mapRole(row: RoleRow): RbacRole {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    isSystem: row.isSystem,
  };
}

function mapPermission(row: PermissionRow): RbacPermission {
  return {
    id: row.id,
    moduleCode: row.module.code as RbacPermission['moduleCode'],
    action: row.action as RbacPermission['action'],
  };
}

export class PrismaRbacUserRepository implements RbacUserRepository {
  constructor(private readonly db = prisma) {}

  async findById(id: string): Promise<RbacUser | null> {
    const row = await (this.db as any).rbacUser.findUnique({
      where: { id },
    }) as RbacUserRow | null;
    return row ? mapUser(row) : null;
  }

  async findByLogin(login: string): Promise<(RbacUser & { passwordHash: string; failedLoginCount: number; lockedUntil: string | null }) | null> {
    const row = await (this.db as any).rbacUser.findUnique({
      where: { login },
    }) as RbacUserRow | null;
    if (!row) return null;
    return {
      ...mapUser(row),
      passwordHash: row.passwordHash,
      failedLoginCount: row.failedLoginCount ?? 0,
      lockedUntil: row.lockedUntil ? row.lockedUntil.toISOString() : null,
    };
  }

  async findByEmail(email: string): Promise<RbacUser | null> {
    const row = await (this.db as any).rbacUser.findUnique({
      where: { email },
    }) as RbacUserRow | null;
    return row ? mapUser(row) : null;
  }

  async create(input: CreateRbacUserInput): Promise<RbacUser> {
    const row = await (this.db as any).rbacUser.create({
      data: {
        name: input.name,
        email: input.email,
        login: input.login,
        passwordHash: input.passwordHash,
        status: input.status ?? 'active',
      },
    }) as RbacUserRow;
    return mapUser(row);
  }

  async updateLastLogin(id: string, at: Date): Promise<void> {
    try {
      await (this.db as any).rbacUser.update({
        where: { id },
        data: { lastLoginAt: at },
      });
    } catch (err) {
      // P2025: record not found — treat as no-op to match InMemory behavior
      if ((err as { code?: string })?.code === 'P2025') return;
      throw err;
    }
  }

  async listRolesForUser(userId: string): Promise<RbacRole[]> {
    const rows = await (this.db as any).rbacUserRole.findMany({
      where: { userId },
      include: { role: true },
    }) as Array<{ role: RoleRow }>;
    return rows.map(r => mapRole(r.role));
  }

  /**
   * Resolves full permission set for a user across all their roles.
   * Uses a single nested include — no N+1 queries.
   */
  async listPermissionsForUser(userId: string): Promise<RbacPermission[]> {
    const rows = await (this.db as any).rbacUserRole.findMany({
      where: { userId },
      include: {
        role: {
          include: {
            permissions: {
              include: {
                permission: {
                  include: { module: { select: { code: true } } },
                },
              },
            },
          },
        },
      },
    }) as Array<{ role: { permissions: Array<{ permission: PermissionRow }> } }>;

    // Deduplicate by permission id (a user can have the same permission via multiple roles)
    const seen = new Set<string>();
    const perms: RbacPermission[] = [];
    for (const ur of rows) {
      for (const rp of ur.role.permissions) {
        if (!seen.has(rp.permission.id)) {
          seen.add(rp.permission.id);
          perms.push(mapPermission(rp.permission));
        }
      }
    }
    return perms;
  }

  // ---------------------------------------------------------------------------
  // SDD #2 additions
  // ---------------------------------------------------------------------------

  async list(): Promise<RbacUser[]> {
    const rows = await (this.db as any).rbacUser.findMany({
      orderBy: { createdAt: 'asc' },
    }) as RbacUserRow[];
    return rows.map(mapUser);
  }

  async update(id: string, patch: UpdateRbacUserInput): Promise<RbacUser> {
    try {
      const data: Record<string, unknown> = {};
      if (patch.name !== undefined) data['name'] = patch.name;
      if (patch.email !== undefined) data['email'] = patch.email;
      if (patch.login !== undefined) data['login'] = patch.login;
      if (patch.status !== undefined) data['status'] = patch.status;
      if (patch.passwordHash !== undefined) data['passwordHash'] = patch.passwordHash;
      if (patch.failedLoginCount !== undefined) data['failedLoginCount'] = patch.failedLoginCount;
      if (patch.lockedUntil !== undefined) data['lockedUntil'] = patch.lockedUntil;
      if ('iclassTeamLogin' in patch) data['iclassTeamLogin'] = patch.iclassTeamLogin ?? null;

      const row = await (this.db as any).rbacUser.update({
        where: { id },
        data,
      }) as RbacUserRow;
      return mapUser(row);
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new Error(`RbacUser not found: ${id}`);
      }
      throw err;
    }
  }

  /**
   * Deletes the user.
   * The SDD #1 migration has ON DELETE CASCADE on RbacUserRole.userId so a
   * single prisma.rbacUser.delete cascades pivot rows automatically.
   * If the cascade is absent, wrap in $transaction([deleteMany pivot, delete user]).
   */
  async delete(id: string): Promise<void> {
    try {
      await (this.db as any).rbacUser.delete({ where: { id } });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2025') {
        return; // already gone — treat as no-op
      }
      throw err;
    }
  }

  /**
   * AD-4: Returns all users with their resolved IClass team info.
   * Join is done via LEFT JOIN on IClassTeam by iclassTeamLogin.
   * iclassTeamLogin=null → teamName=null, teamActive=false.
   */
  async listWithIClassTeam(): Promise<RbacUserWithTeam[]> {
    const rows = await (this.db as any).rbacUser.findMany({
      orderBy: { createdAt: 'asc' },
    }) as RbacUserRow[];

    // Since there's no Prisma relation (soft FK, no FK constraint), we resolve the team
    // via a separate query grouped by distinct iclassTeamLogin values.
    const logins = [...new Set(rows.map((r: RbacUserRow) => r.iclassTeamLogin).filter((l: string | null | undefined): l is string => !!l))];
    const teamMap = new Map<string, { name: string; active: boolean }>();
    if (logins.length > 0) {
      const teams = await (this.db as any).iClassTeam.findMany({
        where: { login: { in: logins } },
        select: { login: true, name: true, active: true },
      }) as Array<{ login: string; name: string; active: boolean }>;
      for (const t of teams) {
        teamMap.set(t.login, { name: t.name, active: t.active });
      }
    }

    return rows.map((row: RbacUserRow) => {
      const login = row.iclassTeamLogin ?? null;
      const team = login ? teamMap.get(login) : undefined;
      return {
        ...mapUser(row),
        iclassTeamLogin: login,
        teamName: team?.name ?? null,
        teamActive: team?.active ?? false,
      };
    });
  }

  /**
   * Counts distinct users with at least one role matching roleCode.
   * Uses a Prisma nested count via the RbacUserRole → RbacRole join.
   *
   * Equivalent SQL (simplified):
   *   SELECT COUNT(DISTINCT u.id)
   *   FROM rbac_users u
   *   JOIN rbac_user_roles ur ON ur.user_id = u.id
   *   JOIN rbac_roles r ON r.id = ur.role_id
   *   WHERE r.code = $1
   */
  async countUsersWithRoleCode(roleCode: string): Promise<number> {
    return (this.db as any).rbacUser.count({
      where: {
        roles: {
          some: {
            role: { code: roleCode },
          },
        },
      },
    }) as Promise<number>;
  }
}
