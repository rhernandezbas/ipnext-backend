/**
 * twilio-credit-guard (task 3.6, D5.c, RATES-2/RATES-3) —
 * `/api/messaging/config/rates` router. Molde EXACTO
 * `externalBulkMessagingConfig.routes.ts` (sesión, NO API key; gate
 * `messaging:read` para GET, `messaging:manage` para PUT; respuesta FLAT sin
 * envelope `{data}`). Naming kebab-case a propósito (D5.c) — el vecino
 * `externalBulkMessagingConfig.routes.ts` es camel-case por herencia; la
 * convención NUEVA de este repo es kebab-case para archivos de ruta.
 *
 * `GET /balance` (D5.c/D6) alimenta la card FE (`MessagingRatesCard`, B4):
 * expone SOLO {available, currency, fetchedAt, cached} — sin el bloque
 * `rates` (la card ya lo tiene de `GET /`). El caller M2M que necesita AMBOS
 * en una sola llamada usa `GET /api/external/v1/messaging/bulk/credit` (D5.a).
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { GetMessagingRatesConfig } from '@application/use-cases/messaging/GetMessagingRatesConfig';
import { SetMessagingRatesConfig } from '@application/use-cases/messaging/SetMessagingRatesConfig';
import { GetMessagingCredit } from '@application/use-cases/messaging/GetMessagingCredit';

export interface MessagingRatesConfigRoutePerms {
  /** GET / y GET /balance — messaging:read. */
  read: RequestHandler;
  /** PUT / — messaging:manage. */
  manage: RequestHandler;
}

export function createMessagingRatesConfigRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  perms: MessagingRatesConfigRoutePerms,
  getMessagingRatesConfig: GetMessagingRatesConfig,
  setMessagingRatesConfig: SetMessagingRatesConfig,
  getMessagingCredit: GetMessagingCredit,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);

  // ─── GET / — tarifas vigentes (RATES-1, read) ──────────────────────────────
  router.get('/', auth, perms.read, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getMessagingRatesConfig.execute());
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT / — update de las 5 tarifas (RATES-2, manage) ─────────────────────
  router.put('/', auth, perms.manage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await setMessagingRatesConfig.execute({
        currency: body['currency'],
        utilityRate: body['utilityRate'],
        marketingRate: body['marketingRate'],
        authenticationRate: body['authenticationRate'],
        providerFee: body['providerFee'],
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /balance — saldo Twilio vigente, SIN el bloque rates (D5.c) ───────
  router.get('/balance', auth, perms.read, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { available, currency, fetchedAt, cached } = await getMessagingCredit.execute();
      res.json({ available, currency, fetchedAt, cached });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
