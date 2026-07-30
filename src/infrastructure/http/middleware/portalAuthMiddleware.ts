import { Request, Response, NextFunction } from 'express';
import type { PortalTokenService } from '@domain/ports/PortalTokenService';
import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';

/**
 * portalAuthMiddleware — customer-portal-api (Fase 2, task 2.4).
 *
 * Bearer-token auth for `/api/portal/*` (mobile app — no cookies). portal-auth
 * spec "Tokens de portal rechazados en rutas admin (y viceversa)": a token is only
 * accepted here when `verifyAccessToken` confirms `aud=portal` (a valid staff JWT,
 * which never carries that audience, is rejected the same as garbage). The account
 * is re-checked on THIS repository on EVERY request (not just at login) — a
 * `disabled` account is rejected even mid-session, same contract as the admin
 * stateful session check.
 *
 * `req.portalClientId`/`req.portalAccountId` are the ONLY source of truth every
 * downstream portal use case reads for scoping — never a body/query param (the
 * anti-IDOR structure the design doc calls out).
 */
export function createPortalAuthMiddleware(tokenService: PortalTokenService, accounts: PortalAccountRepository) {
  return async function portalAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers['authorization'];
    const token =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;

    if (!token) {
      res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
      return;
    }

    const claims = tokenService.verifyAccessToken(token);
    if (!claims) {
      res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
      return;
    }

    try {
      const account = await accounts.findById(claims.accountId);
      if (!account || account.status !== 'active') {
        res.status(401).json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' });
        return;
      }

      req.portalAccountId = account.id;
      req.portalClientId = account.clientId;
      next();
    } catch (err) {
      next(err);
    }
  };
}
