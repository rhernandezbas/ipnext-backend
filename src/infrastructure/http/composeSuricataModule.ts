import { Router, type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { PermissionAction, RbacModuleCode } from '@domain/entities/rbac';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import type { SuricataAreaRepository } from '@domain/ports/SuricataAreaRepository';
import type { SuricataAttachmentRepository } from '@domain/ports/SuricataAttachmentRepository';
import type { FileStorage } from '@domain/ports/FileStorage';
import type { ReplyToSuricataTicket } from '@application/use-cases/suricata/ReplyToSuricataTicket';
import type { ListSuricataTickets } from '@application/use-cases/suricata/ListSuricataTickets';
import type { GetSuricataTicketDetail } from '@application/use-cases/suricata/GetSuricataTicketDetail';
import type { ComputeSuricataKpis } from '@application/use-cases/suricata/ComputeSuricataKpis';
import type { SetSuricataAssignee } from '@application/use-cases/suricata/SetSuricataAssignee';
import { SuricataAttachmentNotFoundError } from '@domain/errors/suricata';
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
  /** suricata-tickets-mirror (Fase F) — GET /tickets, spec UI-1. */
  listSuricataTickets: ListSuricataTickets;
  /** suricata-tickets-mirror (Fase F) — GET /tickets/:id, spec UI-2..UI-5. */
  getSuricataTicketDetail: GetSuricataTicketDetail;
  /** suricata-tickets-mirror (Fase F) — GET /kpis, spec UI-6. */
  computeSuricataKpis: ComputeSuricataKpis;
  /** suricata-tickets-mirror (Fase F) — PATCH /tickets/:id/assignee, spec UI-7. */
  setSuricataAssignee: SetSuricataAssignee;
  /** suricata-tickets-mirror (Fase F) — GET /areas, catálogo simple, sin caso de uso dedicado. */
  areaRepo: SuricataAreaRepository;
  /**
   * suricata-tickets-mirror (Fase H, gap flagged por Fase F, design D7.c) —
   * ruta espejo de la externa: el panel interno (sesión + `suricata.read`)
   * necesita servir el CONTENIDO de un adjunto (ej. reproducir un audio en
   * el tab Conversación, UI-3) sin depender de la key de API externa.
   */
  attachmentRepo: SuricataAttachmentRepository;
  /** MISMO storage/bucket que la ruta externa (D7.a) — sin adapter nuevo. */
  fileStorage: FileStorage;
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

// suricata-tickets-mirror (Fase F, spec UI-1, design D13) — `botState` values
// mirror `SuricataBotState` (domain/entities/suricataBotState.ts) 1:1.
const ListQuerySchema = z.object({
  status: z.string().min(1).optional(),
  priority: z.string().min(1).optional(),
  areaId: z.string().min(1).optional(),
  assigneeId: z.string().min(1).optional(),
  botState: z.enum(['sin_analizar', 'resuelto_bot', 'requiere_humano', 'stale']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// spec UI-7 — `assigneeId: null` clears the assignment; an empty string is
// rejected (not a valid RbacUser id), same criterion as `ReplyBodySchema`.
const AssigneeBodySchema = z.object({
  assigneeId: z.string().min(1).nullable(),
});

/**
 * suricata-tickets-mirror (Fase A — BE Slice 0, design.md D8/D14) — wiring del
 * panel INTERNO (sesión + `suricata.read`/`manage`/`reply`), fuera del cuerpo de
 * `app.ts` (mismo criterio que `composeAlertsModule`/`composeAssistantModule`:
 * evitar inflar el God Object de 3326 líneas).
 *
 * Fase E implementó `POST /tickets/:id/reply` (spec `suricata-ticket-reply`
 * REPLY-1..6, design D10). Fase F (this file's current state) adds the
 * panel's READ routes plus the assignment PATCH (spec `suricata-tickets-ui`
 * UI-1..UI-7, design D13): `GET /tickets`, `GET /tickets/:id`, `GET /areas`,
 * `GET /kpis`, `PATCH /tickets/:id/assignee`. No stub route remains — every
 * path this router exposes is fully implemented.
 *
 * RBAC-2/REPLY-1 — `suricata.reply` es una acción DEDICADA (no `send`), y el
 * `requirePerm` middleware corre ANTES del handler: un caller sin el permiso
 * nunca ejecuta el body de la ruta, así que el `SuricataReplyPort` NUNCA se
 * invoca (el spy en `suricata.reply.routes.test.ts` lo prueba con calls=0).
 * Fase F sigue el mismo criterio: `suricata.read` gatea toda lectura,
 * `suricata.manage` gatea SOLO la asignación (spec UI-7/UI-8).
 */
export function composeSuricataModule(deps: ComposeSuricataModuleDeps): Router {
  const router = Router();
  const auth = createAuthMiddleware(deps.authAdapter, deps.sessionRepo);
  const requireReply = deps.requirePerm('suricata', 'reply');
  const requireRead = deps.requirePerm('suricata', 'read');
  const requireManage = deps.requirePerm('suricata', 'manage');

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

  // ─── GET /tickets (UI-1) ─────────────────────────────────────────────
  router.get('/tickets', auth, requireRead, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = parseOr400(ListQuerySchema, req.query, res);
      if (query === null) return;
      const { page, limit, ...filters } = query;
      const result = await deps.listSuricataTickets.execute({ filters, page, limit });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /areas — catálogo simple para el filtro de área (UI-1) ────────
  router.get('/areas', auth, requireRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const areas = await deps.areaRepo.list();
      res.status(200).json(areas.map((a) => ({ id: a.id, name: a.name, active: a.active })));
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /kpis (UI-6) ────────────────────────────────────────────────
  router.get('/kpis', auth, requireRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const kpis = await deps.computeSuricataKpis.execute();
      res.status(200).json(kpis);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /tickets/:id (UI-2..UI-5) — mirror-only, zero live Suricata calls ──
  router.get(
    '/tickets/:id',
    auth,
    requireRead,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const detail = await deps.getSuricataTicketDetail.execute(req.params['id'] as string);
        res.status(200).json(detail);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /tickets/:id/attachments/:attachmentId/content (D7.c internal mirror) ──
  // suricata-tickets-mirror (Fase H gap) — misma semántica que la ruta EXTERNA
  // (`composeSuricataExternalModule.ts`), pero gateada por sesión + `suricata.read`
  // en vez de la API key. `:id` es el id LOCAL del ticket (mismo criterio que
  // `GET /tickets/:id`), no el `externalId`. El `attachmentId` se valida contra
  // ESE ticket resuelto — un adjunto de OTRO ticket 404ea, nunca 200 (D7.c).
  router.get(
    '/tickets/:id/attachments/:attachmentId/content',
    auth,
    requireRead,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const ticketId = req.params['id'] as string;
        const attachmentId = req.params['attachmentId'] as string;

        const attachment = await deps.attachmentRepo.findById(attachmentId);
        if (!attachment || attachment.ticketId !== ticketId || !attachment.storageKey) {
          throw new SuricataAttachmentNotFoundError(attachmentId);
        }

        const stored = await deps.fileStorage.get(attachment.storageKey);
        if (!stored) throw new SuricataAttachmentNotFoundError(attachmentId);

        res.setHeader('Content-Type', stored.mimeType);
        res.send(stored.buffer);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── PATCH /tickets/:id/assignee (UI-7) — Prominense-ONLY, never writes to
  // Suricata. Gated by `suricata.manage`, distinct from the `suricata.read`
  // gate on every other route in this router (UI-8).
  router.patch(
    '/tickets/:id/assignee',
    auth,
    requireManage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = parseOr400(AssigneeBodySchema, req.body, res);
        if (body === null) return;
        const updated = await deps.setSuricataAssignee.execute({
          ticketId: req.params['id'] as string,
          assigneeId: body.assigneeId,
        });
        res.status(200).json({ id: updated.id, assigneeId: updated.assigneeId });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
