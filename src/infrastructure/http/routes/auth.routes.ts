import { Router, Request, Response } from 'express';
import { JwtAuthAdapter } from '../../adapters/jwt/JwtAuthAdapter';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { AuthenticationError } from '@domain/errors';

export function createAuthRouter(authProvider: JwtAuthAdapter): Router {
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

  router.get('/me', authMiddleware, (req: Request, res: Response): void => {
    res.status(200).json(req.user);
  });

  return router;
}
