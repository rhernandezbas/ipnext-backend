/**
 * Shared contract tests for PasswordHasher port.
 *
 * Call `runPasswordHasherContractTests(makeHasher)` from both the
 * InMemory and Bcrypt test files to ensure both adapters satisfy the same
 * port contract.
 */
import type { PasswordHasher } from '@domain/ports/PasswordHasher';

export function runPasswordHasherContractTests(makeHasher: () => PasswordHasher): void {
  describe('hash', () => {
    it('returns a non-empty string', async () => {
      const hasher = makeHasher();
      const result = await hasher.hash('mypassword');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('does NOT return the plain text (no plaintext leak)', async () => {
      const hasher = makeHasher();
      const plain = 'mypassword';
      const result = await hasher.hash(plain);
      expect(result).not.toBe(plain);
    });
  });

  describe('compare', () => {
    it('resolves true when plain matches the hash', async () => {
      const hasher = makeHasher();
      const plain = 'correctpassword';
      const hash = await hasher.hash(plain);
      await expect(hasher.compare(plain, hash)).resolves.toBe(true);
    });

    it('resolves false when plain does NOT match the hash', async () => {
      const hasher = makeHasher();
      const hash = await hasher.hash('correctpassword');
      await expect(hasher.compare('wrongpassword', hash)).resolves.toBe(false);
    });

    it('resolves false on a malformed hash and does NOT throw', async () => {
      const hasher = makeHasher();
      await expect(hasher.compare('anypassword', 'malformed-string')).resolves.toBe(false);
    });
  });
}
