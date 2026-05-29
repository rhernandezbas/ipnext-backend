/**
 * Contract tests for InMemoryRbacUserRepository.
 *
 * Delegates all assertions to the shared contract suite, which is also run
 * against PrismaRbacUserRepository (skip-gated when DATABASE_URL_TEST is absent).
 */
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { runRbacUserContractTests } from '../../_shared/rbacUserContractTests';

describe('InMemoryRbacUserRepository', () => {
  runRbacUserContractTests(
    () => new InMemoryRbacUserRepository(),
    () => {
      const userRoleRepo = new InMemoryRbacUserRoleRepository();
      const roleRepo = new InMemoryRbacRoleRepository();
      const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);
      return {
        userRepo,
        userRoleRepo,
        seedRole: async (code: string) => {
          const role = await roleRepo.create({ code, label: code, isSystem: true });
          return role.id;
        },
      };
    },
  );
});
