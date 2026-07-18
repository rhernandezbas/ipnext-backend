import type { User } from '@domain/entities/auth';

/**
 * Global augmentation of Express's `Request`.
 *
 * `createAuthMiddleware` (src/infrastructure/http/middleware/authMiddleware.ts)
 * populates `req.user` with the authenticated `User` resolved from the session
 * token. Declaring it here (instead of inside the middleware module) makes the
 * type available program-wide as a single source of truth, so route handlers
 * can read `req.user` directly without `(req as any)` casts.
 */
declare global {
  namespace Express {
    interface Request {
      user?: User;
      /**
       * messaging-inbox-notes (edit/delete) — poblado por `attachMessagingManage`:
       * `true` si el usuario autenticado tiene `messaging:manage` (supervisor). Lo leen
       * las rutas de nota interna (GET messages / PATCH / DELETE) para pasar `hasManage`
       * a los use cases. Ausente fuera de esas rutas.
       */
      messagingCanManage?: boolean;
    }
  }
}

export {};
