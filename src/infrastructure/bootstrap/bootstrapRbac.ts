/**
 * bootstrapRbac — idempotent first-super_admin seed.
 *
 * OPERATOR CHECKLIST (run BEFORE first push):
 *   1. Generate bcrypt hash locally:
 *      node -e "console.log(require('bcryptjs').hashSync('yourPassword', 10))"
 *   2. Set the following secrets in EasyPanel BEFORE pushing:
 *      BOOTSTRAP_RBAC_LOGIN      — login (username) for the bootstrap super_admin
 *      BOOTSTRAP_RBAC_EMAIL      — email for the bootstrap super_admin
 *      BOOTSTRAP_RBAC_NAME       — display name for the bootstrap super_admin
 *      BOOTSTRAP_RBAC_PASSWORD_HASH — the bcrypt hash from step 1 (NOT the plain password)
 *   3. Push BE commit → deploy: prisma migrate deploy → bootstrap-rbac → container starts
 *
 * WARNING: If secrets are NOT set before push → script exits no-op → no RbacUser exists
 *          → nobody can log in → DEADLOCK.
 *
 * Algorithm (idempotent):
 *   1. Any env missing/empty → skip (envs-missing)
 *   2. User with env.login already exists → skip (user-already-exists)
 *   3. Any user already has super_admin role → skip (super_admin-already-assigned)
 *   4. super_admin role not in DB → throw (migration not run)
 *   5. Create user + assign super_admin → return created
 */

import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacRoleRepository } from '@domain/ports/RbacRoleRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';

export interface BootstrapEnv {
  login: string | undefined;
  email: string | undefined;
  name: string | undefined;
  passwordHash: string | undefined;
}

export type BootstrapResult =
  | { outcome: 'skipped'; reason: 'envs-missing' | 'user-already-exists' | 'super_admin-already-assigned' }
  | { outcome: 'created'; login: string };

/**
 * Pure bootstrap function — no process.env reads inside. Injected for testability.
 */
export async function bootstrapRbac(
  userRepo: RbacUserRepository,
  roleRepo: RbacRoleRepository,
  userRoleRepo: RbacUserRoleRepository,
  env: BootstrapEnv,
): Promise<BootstrapResult> {
  // Step 1 — env check
  if (!env.login || !env.email || !env.name || !env.passwordHash) {
    return { outcome: 'skipped', reason: 'envs-missing' };
  }

  // Step 2 — login uniqueness check
  const existingByLogin = await userRepo.findByLogin(env.login);
  if (existingByLogin) {
    return { outcome: 'skipped', reason: 'user-already-exists' };
  }

  // Step 3 — super_admin assignment check
  const superAdminCount = await userRepo.countUsersWithRoleCode('super_admin');
  if (superAdminCount > 0) {
    return { outcome: 'skipped', reason: 'super_admin-already-assigned' };
  }

  // Step 4 — find super_admin role (must exist from SDD #1 migration)
  const superAdminRole = await roleRepo.findByCode('super_admin');
  if (!superAdminRole) {
    throw new Error(
      'super_admin role not found in DB — run prisma migrate deploy first',
    );
  }

  // Step 5 — create user (passwordHash stored verbatim — NOT re-hashed)
  const user = await userRepo.create({
    name: env.name,
    email: env.email,
    login: env.login,
    passwordHash: env.passwordHash,
    status: 'active',
  });

  // Step 6 — assign super_admin role
  await userRoleRepo.assign(user.id, superAdminRole.id);

  return { outcome: 'created', login: env.login };
}

// ---------------------------------------------------------------------------
// main() — entry point when invoked via npm run bootstrap-rbac
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Dynamic imports here to avoid loading Prisma in tests (which use InMemory)
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaRbacUserRepository } = await import(
    '@infrastructure/adapters/prisma/PrismaRbacUserRepository'
  );
  const { PrismaRbacRoleRepository } = await import(
    '@infrastructure/adapters/prisma/PrismaRbacRoleRepository'
  );
  const { PrismaRbacUserRoleRepository } = await import(
    '@infrastructure/adapters/prisma/PrismaRbacUserRoleRepository'
  );

  const prisma = new PrismaClient();
  const userRepo = new PrismaRbacUserRepository(prisma);
  const roleRepo = new PrismaRbacRoleRepository(prisma);
  const userRoleRepo = new PrismaRbacUserRoleRepository(prisma);

  const env: BootstrapEnv = {
    login: process.env.BOOTSTRAP_RBAC_LOGIN,
    email: process.env.BOOTSTRAP_RBAC_EMAIL,
    name: process.env.BOOTSTRAP_RBAC_NAME,
    passwordHash: process.env.BOOTSTRAP_RBAC_PASSWORD_HASH,
  };

  try {
    const result = await bootstrapRbac(userRepo, roleRepo, userRoleRepo, env);

    if (result.outcome === 'skipped') {
      switch (result.reason) {
        case 'envs-missing':
          console.log('[bootstrap-rbac] skipped: envs missing');
          break;
        case 'user-already-exists':
          console.log(`[bootstrap-rbac] skipped: user already exists (login: ${env.login})`);
          break;
        case 'super_admin-already-assigned':
          console.log('[bootstrap-rbac] skipped: super_admin already assigned');
          break;
      }
    } else {
      console.log(`[bootstrap-rbac] created: super_admin ${result.login}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('[bootstrap-rbac] ERROR:', err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run main only when this file is the entry point (not when imported by tests)
if (require.main === module) {
  main();
}
