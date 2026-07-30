import jwt from 'jsonwebtoken';
import { AuthProvider, CookieConfig, LoginCredentials } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import { AuthenticationError } from '@domain/errors';
import type { LoginRbacUser } from '@application/use-cases/rbac/LoginRbacUser';

const COOKIE_NAME = 'auth_token';
const MAX_AGE_SECONDS = 8 * 60 * 60; // 8 hours

/**
 * JWT payload shape (SDD #2+).
 *
 * Breaking change from legacy:
 * - `userId` removed → replaced by `id` (RbacUser.id)
 * - `role` removed → roles resolved per-request by requirePermission middleware
 * - `id`, `login`, `email` are the three required claims
 *
 * Tokens issued before this change are unverifiable (different payload shape +
 * potentially different secret). Users with old tokens will receive a 401 and
 * must log in again — this is expected and documented in the deploy runbook.
 */
interface JwtPayload {
  id: string;
  login: string;
  email: string;
  /**
   * customer-portal-api (Fase 2) — present only on portal tokens (`aud: 'portal'`).
   * Absent on every staff token (today's and every legacy one) — that absence IS
   * the compat contract: only an EXPLICIT `aud: 'portal'` gets rejected below.
   */
  aud?: string;
}

export class JwtAuthAdapter implements AuthProvider {
  private readonly secret: string;
  private readonly cookieSecure: boolean;

  constructor(
    private readonly loginUseCase: LoginRbacUser,
    secret?: string,
    cookieSecure?: boolean,
  ) {
    // Accept injected values (for tests) or fall back to config (production).
    // config is imported lazily to avoid process.exit in test environments that
    // don't have all env vars set.
    if (secret !== undefined) {
      // Test path — never touch config (config.ts runs fail-fast validateEnv).
      this.secret = secret;
      this.cookieSecure = cookieSecure ?? false;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { config } = require('../../config') as { config: { jwtSecret: string; cookieSecure: boolean } };
      this.secret = config.jwtSecret;
      this.cookieSecure = cookieSecure ?? config.cookieSecure;
    }
  }

  async login(credentials: LoginCredentials): Promise<{ user: User; cookieValue: string; cookieOptions: CookieConfig }> {
    // Delegate authentication to LoginRbacUser use case.
    // It throws AuthenticationError for unknown login, wrong password, or inactive user.
    const rbacUser = await this.loginUseCase.execute({
      login: credentials.username,
      password: credentials.password,
    });

    const user: User = {
      id: rbacUser.id,
      username: rbacUser.login,
      email: rbacUser.email,
    };

    const payload: JwtPayload = {
      id: rbacUser.id,
      login: rbacUser.login,
      email: rbacUser.email,
    };
    const cookieValue = jwt.sign(payload, this.secret, { expiresIn: MAX_AGE_SECONDS });

    const cookieOptions: CookieConfig = {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: 'lax',
      maxAge: MAX_AGE_SECONDS * 1000,
      path: '/',
    };

    return { user, cookieValue, cookieOptions };
  }

  logout(): { cookieOptions: CookieConfig } {
    return {
      cookieOptions: {
        httpOnly: true,
        secure: this.cookieSecure,
        sameSite: 'lax',
        maxAge: 0,
        path: '/',
      },
    };
  }

  async getSession(token: string): Promise<User> {
    try {
      const payload = jwt.verify(token, this.secret) as JwtPayload;
      // customer-portal-api (Fase 2, task 2.4) — portal-auth spec "Token de portal
      // contra ruta admin" → 401. A portal token verifies fine against the SAME
      // secret (design decision: one secret, separated by audience) — the explicit
      // `aud === 'portal'` check is the only thing standing between a portal token
      // and full staff access. A token with no `aud` at all (every staff token)
      // sails through unaffected — that's the compat contract.
      if (payload.aud === 'portal') {
        throw new AuthenticationError('Invalid or expired session');
      }
      return {
        id: payload.id,
        username: payload.login,
        email: payload.email,
      };
    } catch {
      throw new AuthenticationError('Invalid or expired session');
    }
  }
}

export { COOKIE_NAME };
