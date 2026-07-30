import { Router, Request, Response, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { CreatePortalAccount } from '@application/use-cases/portal-admin/CreatePortalAccount';
import { RegeneratePortalPassword } from '@application/use-cases/portal-admin/RegeneratePortalPassword';
import { SetPortalAccountStatus } from '@application/use-cases/portal-admin/SetPortalAccountStatus';
import { DeletePortalAccountAdmin } from '@application/use-cases/portal-admin/DeletePortalAccountAdmin';
import { ListPortalAccounts } from '@application/use-cases/portal-admin/ListPortalAccounts';
import { ClientNotFoundError } from '@domain/errors';
import { PortalAccountNotFoundError } from '@domain/errors/portal.errors';
import {
  PortalDniAlreadyUsedError,
  PortalAccountAlreadyExistsError,
  PortalAccountDniRequiredError,
} from '@domain/errors/portalAdmin.errors';
import { parsePagination } from '../parsePagination';

export interface PortalAccountsAdminRouterDeps {
  createPortalAccount: CreatePortalAccount;
  regeneratePortalPassword: RegeneratePortalPassword;
  setPortalAccountStatus: SetPortalAccountStatus;
  deletePortalAccountAdmin: DeletePortalAccountAdmin;
  listPortalAccounts: ListPortalAccounts;
  /** Builds the staff auth middleware (rejects `aud=portal`, same as every other admin router). */
  authProvider: AuthProvider;
  /**
   * H1 (fix wave) — staff SessionRepository for STATEFUL auth: without it,
   * `createAuthMiddleware` degrades to the legacy stateless JWT-only check and a
   * REVOKED staff session keeps operating the CRUD (incl. regenerating client
   * passwords) until the JWT expires. Required, same as every other admin mount.
   */
  sessionRepo: SessionRepository;
  /** `requirePermission(userRepo, 'portal', 'manage')` — built by the caller (app.ts). */
  requirePortalManage: RequestHandler;
}

/**
 * portalAccountsAdmin.routes — customer-portal-api (Fase 3, task 3.4).
 *
 * `/api/admin/portal-accounts` — CRUD administrativo (staff) de cuentas del
 * portal de clientes. Every route: `auth` (staff JWT, rejects `aud=portal`) →
 * `requirePortalManage` (`portal.manage`, guard granular — spec "TODAS las
 * rutas del CRUD DEBEN exigir portal.manage. 'Solo autenticado' NO alcanza.").
 *
 * Error mapping is MANUAL try/catch → instanceof (NOT `next(err)` into the
 * shared `errorHandler` statusMap) — deliberately mirrors the sibling
 * self-service router (`portal.routes.ts`, Fase 2) instead of the more common
 * `next(err)` convention used by other admin routers: this file is built in
 * parallel with the self-service portal routes by a different agent sharing
 * this worktree, and `errorHandler.ts`'s single shared `statusMap` object is
 * unnecessary collision surface neither side needs to touch for this change.
 *
 * NOT mounted in app.ts by this task (3.4) — wiring is explicitly out of scope
 * (design.md risk #3: "hasta que exista la page en Prominense FE, el CRUD se
 * opera por API").
 */
export function createPortalAccountsAdminRouter(deps: PortalAccountsAdminRouterDeps): Router {
  const router = Router();
  const auth = createAuthMiddleware(deps.authProvider, deps.sessionRepo);
  const guard = [auth, deps.requirePortalManage];

  router.post('/', ...guard, async (req: Request, res: Response): Promise<void> => {
    const { clientId, dni } = (req.body ?? {}) as { clientId?: unknown; dni?: unknown };
    if (typeof clientId !== 'string' || !clientId) {
      res.status(400).json({ error: 'clientId es requerido', code: 'VALIDATION_ERROR' });
      return;
    }
    if (dni !== undefined && typeof dni !== 'string') {
      res.status(400).json({ error: 'dni debe ser un string', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const result = await deps.createPortalAccount.execute({ clientId, dni });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof ClientNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
      } else if (err instanceof PortalAccountAlreadyExistsError || err instanceof PortalDniAlreadyUsedError) {
        res.status(409).json({ error: err.message, code: err.code });
      } else if (err instanceof PortalAccountDniRequiredError) {
        res.status(422).json({ error: err.message, code: err.code });
      } else {
        // L6 (fix wave): loguear SIEMPRE antes del 500 — el catch se tragaba el error.
        console.error('[portal-admin] unexpected error on POST /', err);
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
  });

  router.get('/', ...guard, async (req: Request, res: Response): Promise<void> => {
    // M2 (fix wave) — parseo estricto compartido (entero >=1, cap 100): antes
    // `Number('abc')` colaba NaN hasta el adapter (Prisma: skip/take NaN = 500).
    const { page, limit } = parsePagination(req.query);
    try {
      const result = await deps.listPortalAccounts.execute({ page, limit });
      res.status(200).json(result);
    } catch (err) {
      // L6 (fix wave): loguear SIEMPRE antes del 500 — el catch se tragaba el error.
      console.error('[portal-admin] unexpected error on GET /', err);
      res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    }
  });

  router.patch('/:id', ...guard, async (req: Request, res: Response): Promise<void> => {
    const { status } = (req.body ?? {}) as { status?: unknown };
    if (status !== 'active' && status !== 'disabled') {
      res.status(400).json({ error: 'status debe ser active o disabled', code: 'VALIDATION_ERROR' });
      return;
    }
    try {
      const result = await deps.setPortalAccountStatus.execute({ accountId: req.params['id'] as string, status });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof PortalAccountNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
      } else {
        console.error('[portal-admin] unexpected error on PATCH /:id', err);
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
  });

  router.post('/:id/regenerate-password', ...guard, async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await deps.regeneratePortalPassword.execute({ accountId: req.params['id'] as string });
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof PortalAccountNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
      } else {
        console.error('[portal-admin] unexpected error on POST /:id/regenerate-password', err);
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
  });

  router.delete('/:id', ...guard, async (req: Request, res: Response): Promise<void> => {
    try {
      await deps.deletePortalAccountAdmin.execute({ accountId: req.params['id'] as string });
      res.status(204).send();
    } catch (err) {
      if (err instanceof PortalAccountNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
      } else {
        console.error('[portal-admin] unexpected error on DELETE /:id', err);
        res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
  });

  return router;
}
