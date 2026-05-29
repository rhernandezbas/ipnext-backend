/**
 * Contract tests for InMemoryAuditEventRepository.
 * Delegates to the shared suite (also run against Prisma, skip-gated).
 */
import { InMemoryAuditEventRepository } from '@infrastructure/adapters/in-memory/InMemoryAuditEventRepository';
import { runAuditEventContractTests } from '../../_shared/auditEventContractTests';

describe('InMemoryAuditEventRepository', () => {
  runAuditEventContractTests(async () => new InMemoryAuditEventRepository());
});
