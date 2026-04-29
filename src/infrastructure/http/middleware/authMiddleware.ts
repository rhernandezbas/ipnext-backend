import { Request, Response, NextFunction } from 'express';
import { JwtAuthAdapter } from '../../adapters/jwt/JwtAuthAdapter';
import { User } from '@domain/entities/auth';
import { AuthenticationError } from '@domain/errors';

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export function createAuthMiddleware(authProvider: JwtAuthAdapter) {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token: string | undefined = req.cookies?.['auth_token'];
    if (!token) {
      res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
      return;
    }
    try {
      req.user = await authProvider.getSession(token);
      next();
    } catch (err) {
      if (err instanceof AuthenticationError) {
        res.status(401).json({ error: err.message, code: err.code });
      } else {
        res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
      }
    }
  };
}
