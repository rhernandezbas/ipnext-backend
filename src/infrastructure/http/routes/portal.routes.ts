import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { PortalLogin } from '@application/use-cases/portal/PortalLogin';
import { RefreshPortalSession } from '@application/use-cases/portal/RefreshPortalSession';
import { LogoutPortal } from '@application/use-cases/portal/LogoutPortal';
import { ChangePortalPassword } from '@application/use-cases/portal/ChangePortalPassword';
import {
  InvalidPortalCredentialsError,
  InvalidPortalRefreshTokenError,
  PortalRefreshTokenReusedError,
  InvalidCurrentPortalPasswordError,
  PortalPasswordTooShortError,
  PortalAccountNotFoundError,
} from '@domain/errors/portal.errors';
import { createPortalLoginRateLimiter, createPortalGeneralRateLimiter } from '../middleware/rateLimiters';

export interface PortalRouterDeps {
  portalLogin: PortalLogin;
  refreshPortalSession: RefreshPortalSession;
  logoutPortal: LogoutPortal;
  changePortalPassword: ChangePortalPassword;
  /** `createPortalAuthMiddleware(tokenService, accounts)` — guards `/auth/change-password` only. */
  portalAuthMiddleware: RequestHandler;
  /** `createPortalKillSwitchMiddleware(settingsRepo)` — applied to the WHOLE router, login included. */
  killSwitch: RequestHandler;
  /** Defaults to `createPortalLoginRateLimiter()` when omitted. */
  loginRateLimiter?: RequestHandler;
  /** Defaults to `createPortalGeneralRateLimiter()` when omitted. */
  generalRateLimiter?: RequestHandler;
}

/**
 * portal.routes — customer-portal-api (Fase 2, task 2.6).
 *
 * `/api/portal/auth/{login,refresh,logout,change-password}`.
 *
 * Mount order per route (DEVIATION from design.md §4's literal "kill-switch → rate
 * limit → auth" for the ONE authenticated route on this router):
 *   - `/auth/login`:            killSwitch → loginRateLimiter (IP+dni)      → handler
 *   - `/auth/refresh`:          killSwitch → generalRateLimiter (IP, no account yet) → handler
 *   - `/auth/logout`:           killSwitch → generalRateLimiter (IP, no account yet) → handler
 *   - `/auth/change-password`:  killSwitch → portalAuthMiddleware → generalRateLimiter (BY ACCOUNT) → handler
 *
 * The design doc's "rate limit before auth" phrasing describes the GENERAL shape;
 * `change-password` is the only endpoint on this router that's authenticated, and
 * the general limiter is explicitly required to be "por cuenta" (portal-auth spec
 * "Rate limiting del login") — that's only possible once `portalAuthMiddleware` has
 * resolved `req.portalAccountId`. Putting auth first here does not weaken anything:
 * `createPortalGeneralRateLimiter`'s keyGenerator ALSO falls back to IP when no
 * account is set, so mounting it before OR after auth is always safe — this order
 * is simply the one that actually delivers per-account keying where the spec asks
 * for it.
 */
export function createPortalRouter(deps: PortalRouterDeps): Router {
  const router = Router();
  const loginRateLimiter = deps.loginRateLimiter ?? createPortalLoginRateLimiter();
  const generalRateLimiter = deps.generalRateLimiter ?? createPortalGeneralRateLimiter();

  // portal-auth spec "Kill-switch global del portal": in front of EVERY route on
  // this router, login included — a disabled portal must 503 before credentials
  // are ever evaluated.
  router.use(deps.killSwitch);

  router.post('/auth/login', loginRateLimiter, async (req: Request, res: Response): Promise<void> => {
    const { dni, password } = (req.body ?? {}) as { dni?: unknown; password?: unknown };
    if (typeof dni !== 'string' || !dni || typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'dni y password son requeridos', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const result = await deps.portalLogin.execute({ dni, password });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof InvalidPortalCredentialsError) {
        res.status(401).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
  });

  router.post('/auth/refresh', generalRateLimiter, async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: unknown };
    if (typeof refreshToken !== 'string' || !refreshToken) {
      res.status(400).json({ error: 'refreshToken es requerido', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const result = await deps.refreshPortalSession.execute(refreshToken);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof PortalRefreshTokenReusedError || err instanceof InvalidPortalRefreshTokenError) {
        res.status(401).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
  });

  router.post('/auth/logout', generalRateLimiter, async (req: Request, res: Response): Promise<void> => {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: unknown };
    if (typeof refreshToken === 'string' && refreshToken) {
      try {
        await deps.logoutPortal.execute(refreshToken);
      } catch {
        // best-effort — logout must never fail loudly on an already-dead token.
      }
    }
    res.status(204).send();
  });

  router.post(
    '/auth/change-password',
    deps.portalAuthMiddleware,
    generalRateLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
      if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || !newPassword) {
        res.status(400).json({ error: 'currentPassword y newPassword son requeridos', code: 'VALIDATION_ERROR' });
        return;
      }
      const accountId = req.portalAccountId;
      if (!accountId) {
        // Defensive — portalAuthMiddleware always sets this before calling next().
        res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
        return;
      }
      try {
        await deps.changePortalPassword.execute({ accountId, currentPassword, newPassword });
        res.status(200).json({ ok: true });
      } catch (err) {
        if (err instanceof InvalidCurrentPortalPasswordError) {
          res.status(401).json({ error: err.message, code: err.code });
        } else if (err instanceof PortalPasswordTooShortError) {
          res.status(400).json({ error: err.message, code: err.code });
        } else if (err instanceof PortalAccountNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
        } else {
          next(err);
        }
      }
    },
  );

  return router;
}
