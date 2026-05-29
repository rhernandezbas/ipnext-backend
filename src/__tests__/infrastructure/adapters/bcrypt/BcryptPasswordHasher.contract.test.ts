/**
 * Contract tests for BcryptPasswordHasher.
 *
 * Delegates all assertions to the shared contract suite, which is also run
 * against InMemoryPasswordHasher. No database needed.
 *
 * Note: bcrypt hashing is async-CPU bound. Jest's 5s default is sufficient
 * for cost=10 on modern hardware. The suite itself is fast (< 2s).
 */
import { BcryptPasswordHasher } from '@infrastructure/adapters/bcrypt/BcryptPasswordHasher';
import { runPasswordHasherContractTests } from '../_shared/passwordHasherContractTests';

describe('BcryptPasswordHasher', () => {
  runPasswordHasherContractTests(() => new BcryptPasswordHasher());
});
