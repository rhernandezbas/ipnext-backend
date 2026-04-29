import { Request, Response, NextFunction } from 'express';

export function auth(req: Request, res: Response, next: NextFunction): void {
  const token: string | undefined = req.cookies?.['auth_token'];
  if (!token) {
    res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
    return;
  }
  next();
}
