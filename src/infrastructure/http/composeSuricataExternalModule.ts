import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import type { SubmitSuricataVerdict } from '@application/use-cases/suricata/SubmitSuricataVerdict';
import type { SuricataTicketRepository } from '@domain/ports/SuricataTicketRepository';
import type { SuricataAttachmentRepository } from '@domain/ports/SuricataAttachmentRepository';
import type { FileStorage } from '@domain/ports/FileStorage';
import type { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { SuricataAttachmentNotFoundError, SuricataTicketNotFoundError } from '@domain/errors/suricata';

/**
 * suricata-tickets-mirror (Fase D, design.md D0/D7.c/D9) — wiring del
 * endpoint EXTERNO token-autenticado (`suricata-bot-verdict`, RBAC-EXT-3: NO
 * gatea por sesión RBAC ni por permiso — solo la key dedicada, aplicada por
 * el MOUNT en `app.ts`, y el flag `suricata-verdict-enabled` chequeado ACÁ,
 * molde `external-messaging.routes.ts`'s `isFeatureEnabled()`).
 *
 * Dos rutas, MISMO router/mount/key/flag (D7.c):
 *   POST .../tickets/:externalId/verdict                        — VERDICT-1..5
 *   GET  .../tickets/:externalId/attachments/:attachmentId/content — D7.c
 *
 * `parseOr400` (zod `safeParse`, NUNCA `.parse()`) — molde
 * `external-messaging.routes.ts`: un `ZodError` sin capturar no está mapeado
 * en `errorHandler` → 500 en vez de 400.
 */
const FEATURE_FLAG_KEY = 'suricata-verdict-enabled';

function parseOr400<T>(schema: z.ZodType<T>, payload: unknown, res: Response): T | null {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

// VERDICT-2 — shape validation only (types). The CONDITIONAL business rule
// (resuelto=false requires motivo+respuestaSugerida) lives in the use case
// (design D9: "la validación... en el use case, NO en la route"), never here.
const SubmitVerdictBodySchema = z.object({
  resuelto: z.boolean(),
  analisis: z.string().min(1),
  motivo: z.string().min(1).optional(),
  respuestaSugerida: z.string().min(1).optional(),
});

export interface ComposeSuricataExternalModuleDeps {
  submitSuricataVerdict: SubmitSuricataVerdict;
  /** Only used by the D7.c attachment route (existence check of the path's `:externalId`). */
  ticketRepo: SuricataTicketRepository;
  attachmentRepo: SuricataAttachmentRepository;
  fileStorage: FileStorage;
  featureFlags: FeatureFlagRepository;
}

export function composeSuricataExternalModule(deps: ComposeSuricataExternalModuleDeps): Router {
  const router = Router();

  /** Fail-safe a OFF, mismo criterio que el kill-switch de external-bulk-messaging. */
  async function isFeatureEnabled(): Promise<boolean> {
    try {
      return (await deps.featureFlags.get(FEATURE_FLAG_KEY))?.enabled === true;
    } catch {
      return false;
    }
  }

  // ─── POST /tickets/:externalId/verdict (VERDICT-1..5) ──────────────────────
  router.post('/tickets/:externalId/verdict', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!(await isFeatureEnabled())) {
        res.status(403).json({ error: 'Suricata verdict submission is disabled', code: 'FEATURE_DISABLED' });
        return;
      }
      const body = parseOr400(SubmitVerdictBodySchema, req.body, res);
      if (body === null) return;

      const result = await deps.submitSuricataVerdict.execute({
        ticketExternalId: req.params['externalId'] as string,
        ...body,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  // ─── GET /tickets/:externalId/attachments/:attachmentId/content (D7.c) ─────
  // MISMA key + MISMO flag que el veredicto (mismo consumidor: el bot lee el
  // ticket para dictaminarlo). BE-proxy: nunca se emiten URLs firmadas.
  router.get(
    '/tickets/:externalId/attachments/:attachmentId/content',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        if (!(await isFeatureEnabled())) {
          res.status(403).json({ error: 'Suricata verdict submission is disabled', code: 'FEATURE_DISABLED' });
          return;
        }
        const externalId = req.params['externalId'] as string;
        const attachmentId = req.params['attachmentId'] as string;

        const ticket = await deps.ticketRepo.findByExternalId(externalId);
        if (!ticket) throw new SuricataTicketNotFoundError(externalId);

        const attachment = await deps.attachmentRepo.findById(attachmentId);
        // D7.c — un id de OTRO ticket (o un adjunto todavía sin binario) 404ea,
        // NUNCA 200: el `ticketId` de la fila se valida contra el ticket
        // resuelto por el `:externalId` del path, nunca se confía en el id solo.
        if (!attachment || attachment.ticketId !== ticket.id || !attachment.storageKey) {
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

  // ─── catch-all: SELLA el router (molde external-messaging.routes.ts F3/S2) ──
  router.use((_req: Request, res: Response): void => {
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
  });

  return router;
}
