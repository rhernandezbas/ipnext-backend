import bcrypt from 'bcryptjs';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';

const COST = 10; // Same factor used in auth flows across the codebase.

/**
 * BcryptPasswordHasher — production adapter for PasswordHasher port.
 *
 * Uses bcryptjs with cost factor 10. The compare() method wraps bcrypt.compare
 * in a try/catch so malformed hashes return false instead of throwing.
 */
export class BcryptPasswordHasher implements PasswordHasher {
  async hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, COST);
  }

  async compare(plain: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(plain, hash);
    } catch {
      return false; // malformed hash → fail closed, never throw
    }
  }
}
