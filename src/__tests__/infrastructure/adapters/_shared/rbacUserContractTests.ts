/**
 * Shared contract tests for RbacUserRepository.
 *
 * Call `runRbacUserContractTests(makeRepo)` from both the InMemory and Prisma
 * test files to ensure both adapters satisfy the same port contract.
 *
 * The Prisma test calls this inside `describe.skip` when DATABASE_URL_TEST
 * is absent — the InMemory test always runs and provides continuous coverage.
 *
 * For `countUsersWithRoleCode` tests, pass a `SeedContext` that wires the
 * sibling user-role repository so the in-memory adapter can resolve roles.
 */
import type { RbacUserRepository, CreateRbacUserInput } from '@domain/ports/RbacUserRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';

const makeInput = (overrides?: Partial<CreateRbacUserInput>): CreateRbacUserInput => ({
  name: 'Ana García',
  email: 'ana@ipnext.com.ar',
  login: 'ana.garcia',
  passwordHash: 'bcrypt$hash',
  status: 'active',
  ...overrides,
});

/**
 * Seed context required for countUsersWithRoleCode contract tests.
 * All repos must share the same underlying state so that assignments in
 * `userRoleRepo` are visible when `userRepo.countUsersWithRoleCode` runs.
 */
export interface RbacUserRepoSeedContext {
  userRepo: RbacUserRepository;
  userRoleRepo: RbacUserRoleRepository;
  /** Seeds a role with the given code and returns its id. */
  seedRole: (code: string) => Promise<string>;
}

export function runRbacUserContractTests(
  makeRepo: () => RbacUserRepository,
  makeSeedContext?: () => RbacUserRepoSeedContext,
): void {
  describe('create + findById roundtrip', () => {
    it('returns the created user when searched by id', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      const found = await repo.findById(user.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(user.id);
      expect(found!.login).toBe('ana.garcia');
      expect(found!.name).toBe('Ana García');
      expect(found!.email).toBe('ana@ipnext.com.ar');
      expect(found!.status).toBe('active');
    });

    it('generates a unique id for each user created', async () => {
      const repo = makeRepo();
      const u1 = await repo.create(makeInput({ login: 'user1', email: 'u1@x.com' }));
      const u2 = await repo.create(makeInput({ login: 'user2', email: 'u2@x.com' }));
      expect(u1.id).not.toBe(u2.id);
    });
  });

  describe('create', () => {
    it('returned DTO does NOT contain passwordHash', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((user as any).passwordHash).toBeUndefined();
    });

    it('sets createdAt and updatedAt as ISO strings', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      expect(user.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(user.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('defaults status to active when not provided', async () => {
      const repo = makeRepo();
      const { status: _, ...inputWithoutStatus } = makeInput();
      const user = await repo.create(inputWithoutStatus);
      expect(user.status).toBe('active');
    });
  });

  describe('findByLogin', () => {
    it('returns null for an unknown login', async () => {
      const repo = makeRepo();
      const result = await repo.findByLogin('ghost');
      expect(result).toBeNull();
    });

    it('returns user WITH passwordHash for authentication flows', async () => {
      const repo = makeRepo();
      await repo.create(makeInput({ login: 'ana.garcia', passwordHash: 'secret$hash' }));
      const result = await repo.findByLogin('ana.garcia');
      expect(result).not.toBeNull();
      expect(result!.login).toBe('ana.garcia');
      expect(result!.passwordHash).toBe('secret$hash');
    });
  });

  describe('findByEmail', () => {
    it('returns null for an unknown email', async () => {
      const repo = makeRepo();
      const result = await repo.findByEmail('nobody@ipnext.com.ar');
      expect(result).toBeNull();
    });

    it('finds a user by email', async () => {
      const repo = makeRepo();
      await repo.create(makeInput({ email: 'target@ipnext.com.ar' }));
      const result = await repo.findByEmail('target@ipnext.com.ar');
      expect(result).not.toBeNull();
      expect(result!.email).toBe('target@ipnext.com.ar');
    });
  });

  describe('updateLastLogin', () => {
    it('does not throw for an existing user', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      await expect(repo.updateLastLogin(user.id, new Date())).resolves.toBeUndefined();
    });

    it('is a no-op (no throw) for a non-existent user id', async () => {
      const repo = makeRepo();
      await expect(repo.updateLastLogin('nonexistent-id', new Date())).resolves.toBeUndefined();
    });

    it('create yields lastLoginAt null; updateLastLogin then findById returns the timestamp', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());

      // Freshly created user must have lastLoginAt === null
      const fresh = await repo.findById(user.id);
      expect(fresh).not.toBeNull();
      expect(fresh!.lastLoginAt).toBeNull();

      // After updateLastLogin the timestamp must be reflected in findById
      const loginTime = new Date('2026-01-15T10:30:00.000Z');
      await repo.updateLastLogin(user.id, loginTime);
      const updated = await repo.findById(user.id);
      expect(updated).not.toBeNull();
      // lastLoginAt is a string (ISO 8601) in the RbacUser DTO
      const returnedAt = updated!.lastLoginAt;
      expect(returnedAt).not.toBeNull();
      expect(new Date(returnedAt!).toISOString()).toBe(loginTime.toISOString());
    });
  });

  describe('listRolesForUser', () => {
    it('returns empty array for a user with no roles', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      const roles = await repo.listRolesForUser(user.id);
      expect(roles).toEqual([]);
    });
  });

  describe('listPermissionsForUser', () => {
    it('returns empty array for a user with no permissions', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      const perms = await repo.listPermissionsForUser(user.id);
      expect(perms).toEqual([]);
    });
  });

  describe('findById', () => {
    it('returns null for an unknown id', async () => {
      const repo = makeRepo();
      const result = await repo.findById('nonexistent-id');
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // New methods: list, update, delete, countUsersWithRoleCode
  // ---------------------------------------------------------------------------

  describe('list', () => {
    it('returns empty array when no users exist', async () => {
      const repo = makeRepo();
      const result = await repo.list();
      expect(result).toEqual([]);
    });

    it('returns all users after creating two', async () => {
      const repo = makeRepo();
      await repo.create(makeInput({ login: 'alice', email: 'alice@test.com' }));
      await repo.create(makeInput({ login: 'bob', email: 'bob@test.com' }));
      const result = await repo.list();
      expect(result).toHaveLength(2);
      const logins = result.map(u => u.login).sort();
      expect(logins).toEqual(['alice', 'bob']);
    });

    it('returned users do NOT contain passwordHash', async () => {
      const repo = makeRepo();
      await repo.create(makeInput());
      const result = await repo.list();
      expect(result.length).toBe(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result[0] as any).passwordHash).toBeUndefined();
    });
  });

  describe('update', () => {
    it('updates only the provided field (name)', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      const updated = await repo.update(user.id, { name: 'Updated Name' });
      expect(updated.name).toBe('Updated Name');
      expect(updated.email).toBe(user.email);
      expect(updated.login).toBe(user.login);
      expect(updated.status).toBe(user.status);
    });

    it('stores new passwordHash when provided (verify via findByLogin)', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput({ login: 'testlogin', passwordHash: 'oldhash' }));
      await repo.update(user.id, { passwordHash: 'newhash' });
      const found = await repo.findByLogin('testlogin');
      expect(found).not.toBeNull();
      expect(found!.passwordHash).toBe('newhash');
    });

    it('rejects with an error for a non-existent id', async () => {
      const repo = makeRepo();
      await expect(repo.update('nonexistent-id', { name: 'X' })).rejects.toBeTruthy();
    });

    it('sets and clears grVendedorName (soft FK, nullable)', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      // create defaults to null
      expect(user.grVendedorName ?? null).toBeNull();

      const set = await repo.update(user.id, { grVendedorName: 'JUAN PEREZ' });
      expect(set.grVendedorName).toBe('JUAN PEREZ');
      const afterSet = await repo.findById(user.id);
      expect(afterSet!.grVendedorName).toBe('JUAN PEREZ');

      const cleared = await repo.update(user.id, { grVendedorName: null });
      expect(cleared.grVendedorName).toBeNull();
    });

    it('leaves grVendedorName untouched when omitted from patch', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      await repo.update(user.id, { grVendedorName: 'MARIA LOPEZ' });
      const updated = await repo.update(user.id, { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
      expect(updated.grVendedorName).toBe('MARIA LOPEZ');
    });
  });

  describe('delete', () => {
    it('causes subsequent findById to return null', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      await repo.delete(user.id);
      const found = await repo.findById(user.id);
      expect(found).toBeNull();
    });

    it('returns void on success', async () => {
      const repo = makeRepo();
      const user = await repo.create(makeInput());
      await expect(repo.delete(user.id)).resolves.toBeUndefined();
    });
  });

  describe('countUsersWithRoleCode', () => {
    it('returns 0 when no users have the given role code', async () => {
      const repo = makeRepo();
      await repo.create(makeInput());
      const count = await repo.countUsersWithRoleCode('super_admin');
      expect(count).toBe(0);
    });

    if (makeSeedContext) {
      it('returns correct count after seeding 2 users with super_admin role', async () => {
        const { userRepo, userRoleRepo, seedRole } = makeSeedContext!();
        const superAdminRoleId = await seedRole('super_admin');
        const user1 = await userRepo.create(makeInput({ login: 'u1', email: 'u1@test.com' }));
        const user2 = await userRepo.create(makeInput({ login: 'u2', email: 'u2@test.com' }));
        await userRoleRepo.assign(user1.id, superAdminRoleId);
        await userRoleRepo.assign(user2.id, superAdminRoleId);
        const count = await userRepo.countUsersWithRoleCode('super_admin');
        expect(count).toBe(2);
      });

      it('returns 1 when only one of two users has super_admin', async () => {
        const { userRepo, userRoleRepo, seedRole } = makeSeedContext!();
        const superAdminRoleId = await seedRole('super_admin');
        const user1 = await userRepo.create(makeInput({ login: 'sa', email: 'sa@test.com' }));
        await userRepo.create(makeInput({ login: 'regular', email: 'reg@test.com' }));
        await userRoleRepo.assign(user1.id, superAdminRoleId);
        const count = await userRepo.countUsersWithRoleCode('super_admin');
        expect(count).toBe(1);
      });
    }
  });
}
