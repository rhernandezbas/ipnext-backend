import { Router, Request, Response, RequestHandler } from 'express';
import { JwtAuthAdapter } from '../../adapters/jwt/JwtAuthAdapter';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { AuthenticationError, AccountLockedError } from '@domain/errors/index';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { ResolveUserPermissions } from '@application/use-cases/rbac/ResolveUserPermissions';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { hashToken } from '../../auth/sessionToken';

export function createAuthRouter(
  authProvider: JwtAuthAdapter,
  rbacUserRepo: RbacUserRepository,
  rbacUserRoleRepo: RbacUserRoleRepository,
  resolveUserPermissions: ResolveUserPermissions,
  sessionRepo?: SessionRepository,
  loginRateLimiter?: RequestHandler,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(authProvider, sessionRepo);
  // SDD #6a: rate-limit only the login endpoint (no-op passthrough if not injected).
  const loginLimiter: RequestHandler = loginRateLimiter ?? ((_req, _res, next) => next());

  router.post('/login', loginLimiter, async (req: Request, res: Response): Promise<void> => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const { user, cookieValue, cookieOptions } = await authProvider.login({ username, password });
      // SDD #5: record the session BEFORE issuing the cookie (fail-safe: if this
      // throws we fall to the 500 branch and never set the token).
      if (sessionRepo) {
        await sessionRepo.create({
          rbacUserId: user.id,
          actorLogin: user.username,
          tokenHash: hashToken(cookieValue),
          ip: req.ip ?? null,
          userAgent: req.get('user-agent') ?? null,
        });
      }
      res.cookie('auth_token', cookieValue, cookieOptions);
      res.status(200).json({ user });
    } catch (err) {
      if (err instanceof AccountLockedError) {
        res.status(423).json({ error: 'Cuenta bloqueada temporalmente por intentos fallidos', code: 'ACCOUNT_LOCKED' });
      } else if (err instanceof AuthenticationError) {
        res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
      } else {
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
  });

  router.post('/logout', async (req: Request, res: Response): Promise<void> => {
    // SDD #5: revoke the current session (best-effort — always clear the cookie).
    if (sessionRepo) {
      try {
        const token = req.cookies?.['auth_token'] as string | undefined;
        if (token) {
          const session = await sessionRepo.findByTokenHash(hashToken(token));
          if (session) await sessionRepo.revoke(session.id);
        }
      } catch { /* best-effort revoke; never block logout */ }
    }
    const { cookieOptions } = authProvider.logout();
    res.cookie('auth_token', '', cookieOptions);
    res.status(200).json({ ok: true });
  });

  router.get('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = (req as Request & { user?: { id: string } }).user?.id;
      if (!userId) {
        res.status(401).json({ error: 'NO_USER_CONTEXT', code: 'NO_USER_CONTEXT' });
        return;
      }

      const [user, roles, permissions] = await Promise.all([
        rbacUserRepo.findById(userId),
        rbacUserRoleRepo.listRolesForUser(userId),
        resolveUserPermissions.execute(userId),
      ]);

      if (!user) {
        res.status(401).json({ error: 'NO_USER_CONTEXT', code: 'NO_USER_CONTEXT' });
        return;
      }

      res.set('Cache-Control', 'private, max-age=0, must-revalidate');
      res.status(200).json({
        user: {
          id: user.id,
          login: user.login,
          email: user.email,
          name: user.name,
        },
        roles: roles.map((r) => ({ id: r.id, code: r.code, label: r.label })),
        permissions,
      });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
