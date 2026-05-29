/**
 * PasswordHasher — domain port.
 *
 * Abstracts the password hashing algorithm so use cases never import bcrypt
 * directly. Tests inject a fake hasher (prefix "hashed::") for fast assertions.
 *
 * Lives in the domain layer. Zero imports from @infrastructure/* or bcryptjs.
 */
export interface PasswordHasher {
  /** Returns an opaque hash string. The format is adapter-specific. */
  hash(plain: string): Promise<string>;

  /**
   * Constant-time compare. Returns false on malformed hash, never throws.
   * Method name: compare (spec takes precedence over design's `verify`).
   */
  compare(plain: string, hash: string): Promise<boolean>;
}
