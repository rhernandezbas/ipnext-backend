/**
 * Contract tests for InMemoryRbacUserRepository.
 *
 * Delegates all assertions to the shared contract suite, which is also run
 * against PrismaRbacUserRepository (skip-gated when DATABASE_URL_TEST is absent).
 */
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { runRbacUserContractTests } from '../../_shared/rbacUserContractTests';

describe('InMemoryRbacUserRepository', () => {
  runRbacUserContractTests(() => new InMemoryRbacUserRepository());
});
