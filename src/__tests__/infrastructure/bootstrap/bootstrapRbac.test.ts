import { bootstrapRbac, type BootstrapEnv } from '@infrastructure/bootstrap/bootstrapRbac';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepos() {
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);
  return { userRepo, roleRepo, userRoleRepo };
}

const validEnv: BootstrapEnv = {
  login: 'admin',
  email: 'admin@test.com',
  name: 'Admin User',
  passwordHash: '$2a$10$examplehashvalue',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bootstrapRbac', () => {
  it('Path A — missing any env var: skips without writing to DB', async () => {
    const { userRepo, roleRepo, userRoleRepo } = makeRepos();
    await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });

    const missingLogin = await bootstrapRbac(userRepo, roleRepo, userRoleRepo, { ...validEnv, login: undefined });
    expect(missingLogin).toEqual({ outcome: 'skipped', reason: 'envs-missing' });

    const missingEmail = await bootstrapRbac(userRepo, roleRepo, userRoleRepo, { ...validEnv, email: '' });
    expect(missingEmail).toEqual({ outcome: 'skipped', reason: 'envs-missing' });

    const missingName = await bootstrapRbac(userRepo, roleRepo, userRoleRepo, { ...validEnv, name: undefined });
    expect(missingName).toEqual({ outcome: 'skipped', reason: 'envs-missing' });

    const missingHash = await bootstrapRbac(userRepo, roleRepo, userRoleRepo, { ...validEnv, passwordHash: undefined });
    expect(missingHash).toEqual({ outcome: 'skipped', reason: 'envs-missing' });

    // Verify no writes occurred
    const users = await userRepo.list();
    expect(users).toHaveLength(0);
  });

  it('Path B — login already exists: skips without writing to DB', async () => {
    const { userRepo, roleRepo, userRoleRepo } = makeRepos();
    await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });

    // Pre-seed a user with the same login
    await userRepo.create({
      name: 'Existing User',
      email: 'existing@test.com',
      login: validEnv.login!,
      passwordHash: 'existinghash',
      status: 'active',
    });

    const result = await bootstrapRbac(userRepo, roleRepo, userRoleRepo, validEnv);
    expect(result).toEqual({ outcome: 'skipped', reason: 'user-already-exists' });

    // Only 1 user (the pre-seeded one) — no new user created
    const users = await userRepo.list();
    expect(users).toHaveLength(1);
    expect(users[0].login).toBe(validEnv.login);
    expect(users[0].email).toBe('existing@test.com');
  });

  it('Path B — super_admin already assigned to a different user: skips without writing', async () => {
    const { userRepo, roleRepo, userRoleRepo } = makeRepos();
    const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });

    // Pre-seed a different user with super_admin role
    const existingUser = await userRepo.create({
      name: 'Existing Super Admin',
      email: 'super@test.com',
      login: 'superadmin',
      passwordHash: 'existinghash',
      status: 'active',
    });
    await userRoleRepo.assign(existingUser.id, superAdminRole.id);

    const result = await bootstrapRbac(userRepo, roleRepo, userRoleRepo, validEnv);
    expect(result).toEqual({ outcome: 'skipped', reason: 'super_admin-already-assigned' });

    // Only 1 user (the pre-seeded one) — no new user created
    const users = await userRepo.list();
    expect(users).toHaveLength(1);
  });

  it('Path C — fresh state: creates user with verbatim passwordHash and assigns super_admin', async () => {
    const { userRepo, roleRepo, userRoleRepo } = makeRepos();
    const superAdminRole = await roleRepo.create({ code: 'super_admin', label: 'Super Admin', isSystem: true });

    const result = await bootstrapRbac(userRepo, roleRepo, userRoleRepo, validEnv);

    expect(result).toEqual({ outcome: 'created', login: validEnv.login });

    // User was created
    const users = await userRepo.list();
    expect(users).toHaveLength(1);
    expect(users[0].login).toBe(validEnv.login);
    expect(users[0].email).toBe(validEnv.email);
    expect(users[0].name).toBe(validEnv.name);
    expect(users[0].status).toBe('active');

    // passwordHash stored VERBATIM (not re-hashed)
    const userWithHash = await userRepo.findByLogin(validEnv.login!);
    expect(userWithHash).not.toBeNull();
    expect(userWithHash!.passwordHash).toBe(validEnv.passwordHash);

    // super_admin role assigned
    const assignedRoles = await userRoleRepo.listForUser(users[0].id);
    expect(assignedRoles).toContain(superAdminRole.id);
  });

  it('Error path — super_admin role not in DB: throws with clear message', async () => {
    const { userRepo, roleRepo, userRoleRepo } = makeRepos();
    // No super_admin role seeded

    await expect(
      bootstrapRbac(userRepo, roleRepo, userRoleRepo, validEnv)
    ).rejects.toThrow('super_admin role not found');
  });
});
