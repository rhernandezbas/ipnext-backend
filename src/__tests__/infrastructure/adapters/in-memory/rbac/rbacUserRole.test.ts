/**
 * Contract tests for InMemoryRbacUserRoleRepository.
 *
 * Delegates all assertions to the shared contract suite, which is also run
 * against PrismaRbacUserRoleRepository (skip-gated when DATABASE_URL_TEST is absent).
 */
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { runRbacUserRoleContractTests } from '../../_shared/rbacUserRoleContractTests';

describe('InMemoryRbacUserRoleRepository', () => {
  runRbacUserRoleContractTests(() => {
    // Both repo and seeder share the same InMemoryRbacRoleRepository instance
    // so that roles seeded for the tests are visible when listRolesForUser resolves them.
    const roleRepo = new InMemoryRbacRoleRepository();
    const repo = new InMemoryRbacUserRoleRepository(roleRepo);
    return {
      repo,
      seeder: { seedRole: (input) => roleRepo.create(input) },
    };
  });
});
