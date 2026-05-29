import { Router, Request, Response } from 'express';
import { JwtAuthAdapter } from '../../adapters/jwt/JwtAuthAdapter';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { AuthenticationError } from '@domain/errors/index';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { RbacUserRoleRepository } from '@domain/ports/RbacUserRoleRepository';
import type { ResolveUserPermissions } from '@application/use-cases/rbac/ResolveUserPermissions';

export function createAuthRouter(
  authProvider: JwtAuthAdapter,
  rbacUserRepo: RbacUserRepository,
  rbacUserRoleRepo: RbacUserRoleRepository,
  resolveUserPermissions: ResolveUserPermissions,
): Router {
  const router = Router();
  const authMiddleware = createAuthMiddleware(authProvider);

  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const { user, cookieValue, cookieOptions } = await authProvider.login({ username, password });
      res.cookie('auth_token', cookieValue, cookieOptions);
      res.status(200).json({ user });
    } catch (err) {
      if (err instanceof AuthenticationError) {
        res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
      } else {
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
  });

  router.post('/logout', (_req: Request, res: Response): void => {
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
