import type { PasswordHasher } from '@domain/ports/PasswordHasher';

/**
 * InMemoryPasswordHasher — test seam for PasswordHasher.
 *
 * Prefixes "hashed::" so:
 *   - tests can assert that `passwordHash` was stored hashed (not plain)
 *   - compare() is a string-equality check after applying the same prefix
 *
 * NEVER use in production — relies on DI to never wire this in main.ts.
 */
export class InMemoryPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return `hashed::${plain}`;
  }

  async compare(plain: string, hash: string): Promise<boolean> {
    return hash === `hashed::${plain}`;
  }
}
