import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import { AuthenticationError } from '@domain/errors';

export interface LoginRbacUserCredentials {
  login: string;
  password: string;
}

export interface LoginRbacUserResult {
  id: string;
  login: string;
  email: string;
  name: string;
}

/**
 * LoginRbacUser — validates credentials against RbacUser records.
 *
 * Security contract:
 * - Both unknown login AND wrong password throw the SAME AuthenticationError
 *   to prevent login enumeration. Internal distinction is intentional for
 *   logging (different code paths), but the caller sees the same error.
 * - A disabled user is rejected the same way (AuthenticationError) — no leaking
 *   of account status to unauthenticated callers.
 * - On success: updateLastLogin is called before returning.
 */
export class LoginRbacUser {
  constructor(
    private readonly usersRepo: RbacUserRepository,
    private readonly hasher: PasswordHasher,
  ) {}

  async execute(credentials: LoginRbacUserCredentials): Promise<LoginRbacUserResult> {
    const { login, password } = credentials;

    const user = await this.usersRepo.findByLogin(login);

    // Unknown login: throw AuthenticationError (same public shape as wrong password)
    if (!user) {
      throw new AuthenticationError('Invalid credentials');
    }

    // Inactive user: reject before checking password to avoid bcrypt timing cost
    // on disabled accounts (also prevents enumeration of active vs disabled)
    if (user.status !== 'active') {
      throw new AuthenticationError('Invalid credentials');
    }

    // Wrong password
    const valid = await this.hasher.compare(password, user.passwordHash);
    if (!valid) {
      throw new AuthenticationError('Invalid credentials');
    }

    // Update last login timestamp
    await this.usersRepo.updateLastLogin(user.id, new Date());

    return {
      id: user.id,
      login: user.login,
      email: user.email,
      name: user.name,
    };
  }
}
