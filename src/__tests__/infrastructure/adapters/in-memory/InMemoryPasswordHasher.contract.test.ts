/**
 * Contract tests for InMemoryPasswordHasher.
 *
 * Delegates all assertions to the shared contract suite, which is also run
 * against BcryptPasswordHasher.
 *
 * RED phase: this file intentionally imports the not-yet-created
 * InMemoryPasswordHasher — it will fail until task 1.2 is complete.
 */
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';
import { runPasswordHasherContractTests } from '../_shared/passwordHasherContractTests';

describe('InMemoryPasswordHasher', () => {
  runPasswordHasherContractTests(() => new InMemoryPasswordHasher());
});
