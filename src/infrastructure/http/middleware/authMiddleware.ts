import { Request, Response, NextFunction } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { AuthenticationError } from '@domain/errors';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { isSessionAlive } from '@domain/entities/session.policy';
import { hashToken } from '../../auth/sessionToken';

// `Express.Request.user` is augmented globally in src/types/express.d.ts.

const TOUCH_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Auth middleware. When a `sessionRepo` is provided (production), auth is
 * STATEFUL: after verifying the JWT, the token's session must exist and not be
 * revoked, else 401 (SDD #5). `lastSeenAt` is touched at most every 5 min.
 * Without a `sessionRepo`, behaviour is the legacy stateless JWT-only check.
 *
 * fix/auth-stateful-routers: `sessionRepo` stays OPTIONAL here on purpose (see that
 * change's report for why a mandatory param was rejected), but every router under
 * `src/infrastructure/http/routes/` MUST call this with both arguments — omitting
 * `sessionRepo` there means a REVOKED staff session keeps authenticating until the
 * JWT expires (up to 8h). This is enforced by
 * `src/__tests__/infrastructure/statefulAuthRoutes.architecture.test.ts`, which scans
 * every file in that directory and fails, by name, on any single-argument call. If
 * you are adding a new router that legitimately needs the legacy stateless mode
 * (public/anonymous endpoints do NOT — see `profile.routes.ts` for the one real
 * legacy exception, which never calls this function at all), add it to that test's
 * `ALLOWLIST` with a reason, not just to app.ts.
 */
export function createAuthMiddleware(authProvider: AuthProvider, sessionRepo?: SessionRepository) {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const token: string | undefined = req.cookies?.['auth_token'];
    if (!token) {
      res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
      return;
    }

    try {
      req.user = await authProvider.getSession(token);
    } catch (err) {
      if (err instanceof AuthenticationError) {
        res.status(401).json({ error: err.message, code: err.code });
      } else {
        res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
      }
      return;
    }

    if (sessionRepo) {
      try {
        const session = await sessionRepo.findByTokenHash(hashToken(token));
        // findByTokenHash already excludes revoked/expired/idle sessions; the
        // explicit isSessionAlive check is defence in depth (same 401 either way).
        if (!session || !isSessionAlive(session)) {
          res.status(401).json({ error: 'Session revoked or expired', code: 'UNAUTHORIZED' });
          return;
        }
        const last = Date.parse(session.lastSeenAt);
        if (Number.isNaN(last) || Date.now() - last > TOUCH_THROTTLE_MS) {
          // fire-and-forget; auditing/lastSeenAt must never block or break the request
          void sessionRepo.touch(session.id).catch(() => { /* ignore */ });
        }
      } catch (err) {
        next(err);
        return;
      }
    }

    next();
  };
}
