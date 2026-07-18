import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { UpdateNocBroadcastConfigSchema } from '@application/dto/nocBroadcast.dto';
import { GetNocBroadcastConfig } from '@application/use-cases/nocBroadcast/GetNocBroadcastConfig';
import { UpdateNocBroadcastConfig } from '@application/use-cases/nocBroadcast/UpdateNocBroadcastConfig';
import { SendNocBroadcastTest } from '@application/use-cases/nocBroadcast/SendNocBroadcastTest';

/**
 * N1 (noc-broadcast) — `/api/messaging/noc-broadcast` router. Foundation config +
 * test endpoint for the NOC WhatsApp broadcast (Evolution API). N2/N3 reuse the
 * engine (BroadcastToNoc), not this router.
 *
 * Molde: `gestionRealIngest.routes` (factory + authProvider, Zod `safeParse` →
 * 400 VALIDATION_ERROR, try/catch → next(err) → errorHandler global) + the
 * `{ read, manage }` perms object of the messaging settings cards
 * (`cannedResponses.routes`).
 *
 * RBAC: GET /config = messaging:read (ver la config enmascarada); PUT /config +
 * POST /test = messaging:manage (SOLO supervisores editan credenciales / disparan
 * el envío) — mismo permiso "supervisor" que ya gobierna canned-responses/notas.
 */
export interface NocBroadcastRoutePerms {
  /** GET /config — messaging:read. */
  read: RequestHandler;
  /** PUT /config + POST /test — messaging:manage. */
  manage: RequestHandler;
}

export function createNocBroadcastRouter(
  authProvider: AuthProvider,
  perms: NocBroadcastRoutePerms,
  getNocBroadcastConfig: GetNocBroadcastConfig,
  updateNocBroadcastConfig: UpdateNocBroadcastConfig,
  sendNocBroadcastTest: SendNocBroadcastTest,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // ─── GET /config — masked config DTO (read) ─────────────────────────────────
  router.get('/config', auth, perms.read, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getNocBroadcastConfig.execute());
    } catch (err) {
      next(err);
    }
  });

  // ─── PUT /config — update (manage) ──────────────────────────────────────────
  // Zod partial; empty/absent apiKey preserves the stored secret (use-case rule).
  router.put('/config', auth, perms.manage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateNocBroadcastConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateNocBroadcastConfig.execute(parsed.data));
    } catch (err) {
      next(err);
    }
  });

  // ─── POST /test — send the probe message (manage) ───────────────────────────
  // Typed errors bubble to the global handler: NOC_BROADCAST_NOT_CONFIGURED → 503,
  // EVOLUTION_API_ERROR → 502.
  router.post('/test', auth, perms.manage, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await sendNocBroadcastTest.execute());
    } catch (err) {
      next(err);
    }
  });

  return router;
}
