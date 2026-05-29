import { randomUUID } from 'crypto';
import type { RbacUser, RbacRole, RbacPermission } from '@domain/entities/rbac';
import type { CreateRbacUserInput, RbacUserRepository } from '@domain/ports/RbacUserRepository';

interface StoredUser {
  user: RbacUser;
  passwordHash: string;
  lastLoginAt: Date | null;
}

/**
 * InMemoryRbacUserRepository — test seam for RbacUserRepository.
 *
 * Stores users in a plain Map. No external dependencies.
 * listRolesForUser and listPermissionsForUser return empty arrays — they are
 * resolved by the middleware through separate pivot repos in production,
 * but the base adapter can be extended via seedRole/seedPermission helpers
 * in tests that need full role/permission resolution.
 */
export class InMemoryRbacUserRepository implements RbacUserRepository {
  private readonly store = new Map<string, StoredUser>();

  async findById(id: string): Promise<RbacUser | null> {
    const entry = this.store.get(id);
    if (!entry) return null;
    return {
      ...entry.user,
      lastLoginAt: entry.lastLoginAt ? entry.lastLoginAt.toISOString() : null,
    };
  }

  async findByLogin(login: string): Promise<(RbacUser & { passwordHash: string }) | null> {
    for (const entry of this.store.values()) {
      if (entry.user.login === login) {
        return {
          ...entry.user,
          lastLoginAt: entry.lastLoginAt ? entry.lastLoginAt.toISOString() : null,
          passwordHash: entry.passwordHash,
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
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    this.store.set(user.id, { user, passwordHash: input.passwordHash, lastLoginAt: null });
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
}
