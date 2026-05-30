/**
 * Contract tests for InMemorySessionRepository.
 */
import { InMemorySessionRepository } from '@infrastructure/adapters/in-memory/InMemorySessionRepository';
import { runSessionContractTests } from '../../_shared/sessionContractTests';

describe('InMemorySessionRepository', () => {
  runSessionContractTests(async () => new InMemorySessionRepository());
});
