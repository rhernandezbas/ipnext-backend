/**
 * Contract tests for InMemoryRbacRolePermissionRepository.
 *
 * Delegates all assertions to the shared contract suite, which is also run
 * against PrismaRbacRolePermissionRepository (skip-gated when DATABASE_URL_TEST is absent).
 */
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { runRbacRolePermissionContractTests } from '../../_shared/rbacRolePermissionContractTests';

describe('InMemoryRbacRolePermissionRepository', () => {
  runRbacRolePermissionContractTests(() => new InMemoryRbacRolePermissionRepository());
});
