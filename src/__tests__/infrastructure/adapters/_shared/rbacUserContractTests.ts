/**
 * Shared contract tests for RbacUserRepository.
 *
 * Call `runRbacUserContractTests(() => new YourRepo())` from both the
 * InMemory and Prisma test files to ensure both adapters satisfy the same
 * port contract.
 *
 * The Prisma test calls this inside `describe.skip` when DATABASE_URL_TEST
 * is absent — the InMemory test always runs and provides continuous coverage.
 */
import type { RbacUserRepository, CreateRbacUserInput } from '@domain/ports/RbacUserRepository';

const makeInput = (overrides?: Partial<CreateRbacUserInput>): CreateRbacUserInput => ({
  name: 'Ana García',
  email: 'ana@ipnext.com.ar',
  login: 'ana.garcia',
  passwordHash: 'bcrypt$hash',
  status: 'active',
  ...overrides,
});

export function runRbacUserContractTests(makeRepo: () => RbacUserRepository): void {
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
}
