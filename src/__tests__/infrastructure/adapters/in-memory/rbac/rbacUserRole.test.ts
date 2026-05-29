/**
 * Contract tests for InMemoryRbacUserRoleRepository.
 *
 * Delegates all assertions to the shared contract suite, which is also run
 * against PrismaRbacUserRoleRepository (skip-gated when DATABASE_URL_TEST is absent).
 */
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { runRbacUserRoleContractTests } from '../../_shared/rbacUserRoleContractTests';

describe('InMemoryRbacUserRoleRepository', () => {
  runRbacUserRoleContractTests(() => new InMemoryRbacUserRoleRepository());
});
