import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import { AuthenticationError, AccountLockedError } from '@domain/errors';

/** SDD #6a — account lockout policy. */
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

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
    /** Clock seam for deterministic lockout tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(credentials: LoginRbacUserCredentials): Promise<LoginRbacUserResult> {
    const { login, password } = credentials;
    const now = this.now();

    const user = await this.usersRepo.findByLogin(login);

    // Unknown login: throw AuthenticationError (same public shape as wrong password)
    if (!user) {
      throw new AuthenticationError('Invalid credentials');
    }

    // SDD #6a — locked account: reject BEFORE the password check, even if correct.
    if (user.lockedUntil && new Date(user.lockedUntil) > now) {
      throw new AccountLockedError();
    }

    // Inactive user: reject before checking password to avoid bcrypt timing cost
    // on disabled accounts (also prevents enumeration of active vs disabled)
    if (user.status !== 'active') {
      throw new AuthenticationError('Invalid credentials');
    }

    // Wrong password → bump failed counter, lock at the threshold.
    const valid = await this.hasher.compare(password, user.passwordHash);
    if (!valid) {
      const next = user.failedLoginCount + 1;
      if (next >= MAX_FAILED) {
        await this.usersRepo.update(user.id, {
          failedLoginCount: 0,
          lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000),
        });
      } else {
        await this.usersRepo.update(user.id, { failedLoginCount: next });
      }
      throw new AuthenticationError('Invalid credentials');
    }

    // Success → reset the counter/lock if dirty, then stamp last login.
    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await this.usersRepo.update(user.id, { failedLoginCount: 0, lockedUntil: null });
    }
    await this.usersRepo.updateLastLogin(user.id, now);

    return {
      id: user.id,
      login: user.login,
      email: user.email,
      name: user.name,
    };
  }
}
