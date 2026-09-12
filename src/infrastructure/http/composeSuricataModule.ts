import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { PermissionAction, RbacModuleCode } from '@domain/entities/rbac';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { ReplyToSuricataTicket } from '@application/use-cases/suricata/ReplyToSuricataTicket';
import { createAuthMiddleware } from './middleware/authMiddleware';

export interface ComposeSuricataModuleDeps {
  authAdapter: AuthProvider;
  sessionRepo: SessionRepository;
  /** El `requirePerm` de app.ts, INYECTADO — no re-derivado acá (un solo rbacUserRepo). */
  requirePerm: (module: RbacModuleCode, action: PermissionAction) => RequestHandler;
  /** suricata-tickets-mirror (Fase E) — POST /tickets/:id/reply, D10. */
  replyToSuricataTicket: ReplyToSuricataTicket;
  /** suricata-tickets-mirror (Fase E) — gate del flag `suricata-reply-enabled` (Fase A, dark). */
  featureFlags: FeatureFlagRepository;
}

/** suricata-tickets-mirror (Fase A, dark por default) — Fase A migration ya lo sembró en `false`. */
const REPLY_FEATURE_FLAG_KEY = 'suricata-reply-enabled';

/** molde `external-messaging.routes.ts`'s `isFeatureEnabled()` / composeSuricataExternalModule.ts. */
function parseOr400<T>(schema: z.ZodType<T>, payload: unknown, res: Response): T | null {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

// REPLY-2 — shape validation only. The CONDITIONAL confirmation check
// (sha256(body) === confirm) lives in `ReplyToSuricataTicket`, never here.
const ReplyBodySchema = z.object({
  body: z.string().min(1),
  confirm: z.string().min(1),
});

/**
 * suricata-tickets-mirror (Fase A — BE Slice 0, design.md D8/D14) — wiring del
 * panel INTERNO (sesión + `suricata.read`/`manage`/`reply`), fuera del cuerpo de
 * `app.ts` (mismo criterio que `composeAlertsModule`/`composeAssistantModule`:
 * evitar inflar el God Object de 3326 líneas).
 *
 * Fase E reemplaza SOLO `POST /tickets/:id/reply` (spec `suricata-ticket-reply`
 * REPLY-1..6, design D10) — el resto de las rutas (`GET /tickets`, `GET /:id`,
 * `GET /areas`, `GET /kpis`, `PATCH /:id/assignee`) siguen 501 (Fase F scope).
 *
 * RBAC-2/REPLY-1 — `suricata.reply` es una acción DEDICADA (no `send`), y el
 * `requirePerm` middleware corre ANTES del handler: un caller sin el permiso
 * nunca ejecuta el body de la ruta, así que el `SuricataReplyPort` NUNCA se
 * invoca (el spy en `suricata.reply.routes.test.ts` lo prueba con calls=0).
 */
export function composeSuricataModule(deps: ComposeSuricataModuleDeps): Router {
  const router = Router();
  const auth = createAuthMiddleware(deps.authAdapter, deps.sessionRepo);
  const requireReply = deps.requirePerm('suricata', 'reply');

  /** Fail-safe a OFF, mismo criterio que el kill-switch de external-bulk-messaging. */
  async function isReplyEnabled(): Promise<boolean> {
    try {
      return (await deps.featureFlags.get(REPLY_FEATURE_FLAG_KEY))?.enabled === true;
    } catch {
      return false;
    }
  }

  // ─── POST /tickets/:id/reply (REPLY-1..6, D10) ──────────────────────────
  router.post(
    '/tickets/:id/reply',
    auth,
    requireReply,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        if (!(await isReplyEnabled())) {
          res.status(403).json({ error: 'Suricata reply is disabled', code: 'FEATURE_DISABLED' });
          return;
        }
        const body = parseOr400(ReplyBodySchema, req.body, res);
        if (body === null) return;

        const result = await deps.replyToSuricataTicket.execute({
          ticketId: req.params['id'] as string,
          // requirePerm already 401s if req.user is missing — safe to assert here.
          actorId: req.user!.id,
          body: body.body,
          confirm: body.confirm,
        });
        res.status(202).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── Fase F scope: GET /tickets, GET /:id, GET /areas, GET /kpis, PATCH /:id/assignee ─
  router.use((_req, res) => {
    res.status(501).json({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
  });

  return router;
}
