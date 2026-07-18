/**
 * Ola 4 (inbox-Chatwoot) — router `/api/messaging/canned-responses` (respuestas rápidas /
 * macros del composer). CRUD del catálogo de atajos de texto. El envío NO se toca: el FE
 * inserta el `content` en el textarea y usa el POST /messages normal.
 *
 * Molde `templates.routes.ts`: factory + perms interface, auth aplicada POR RUTA, cada
 * handler async try/catch → next(err) (el errorHandler global mapea los DomainError
 * tipados vía statusMap — fuente única). Zod valida el SHAPE del body (fields presentes y
 * strings); la semántica (normalizar shortcut a slug, content no vacío, unicidad) vive en
 * los use cases y emerge como VALIDATION_ERROR / SHORTCUT_TAKEN / CANNED_RESPONSE_NOT_FOUND.
 *
 * RBAC doble capa: GET (lista/picker) = messaging:read (cualquier agente USA las respuestas);
 * POST/PUT/DELETE (gestión) = messaging:manage (SOLO supervisores CREAN/editan/borran — el
 * mismo permiso "supervisor" que ya gobierna las notas internas).
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';
import { ListCannedResponses } from '@application/use-cases/messaging/ListCannedResponses';
import { CreateCannedResponse } from '@application/use-cases/messaging/CreateCannedResponse';
import { UpdateCannedResponse } from '@application/use-cases/messaging/UpdateCannedResponse';
import { DeleteCannedResponse } from '@application/use-cases/messaging/DeleteCannedResponse';

/** Per-route permission guards. read=messaging:read, manage=messaging:manage. */
export interface CannedResponsesRoutePerms {
  /** GET (lista/picker) — cualquier agente con acceso al inbox. */
  read: RequestHandler;
  /** POST/PUT/DELETE (gestión) — supervisor (messaging:manage). */
  manage: RequestHandler;
}

// El body sólo se valida como SHAPE — la normalización/validación semántica es del use case.
const createBodySchema = z.object({
  shortcut: z.string().min(1),
  content: z.string().min(1),
});
const updateBodySchema = z
  .object({
    shortcut: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
  })
  .refine((d) => d.shortcut !== undefined || d.content !== undefined, {
    message: 'at least one of shortcut or content must be provided',
  });

/** Toma el primer valor de un query param (normaliza `?q=a&q=b` → 'a'). */
function firstQueryValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

export function createCannedResponsesRouter(
  listCannedResponses: ListCannedResponses,
  createCannedResponse: CreateCannedResponse,
  updateCannedResponse: UpdateCannedResponse,
  deleteCannedResponse: DeleteCannedResponse,
  auth: RequestHandler,
  perms: CannedResponsesRoutePerms,
): Router {
  const router = Router();

  // ─── GET / — lista/picker (read: messaging:read) ────────────────────────────
  router.get(
    '/',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const q = firstQueryValue(req.query['q']);
        const data = await listCannedResponses.execute(q ? { q } : undefined);
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── POST / — crear (manage: messaging:manage) ──────────────────────────────
  router.post(
    '/',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const parsed = createBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: 'shortcut and content must be non-empty strings', code: 'VALIDATION_ERROR' });
          return;
        }
        const created = await createCannedResponse.execute({
          shortcut: parsed.data.shortcut,
          content: parsed.data.content,
          createdById: req.user?.id ?? null,
        });
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── PUT /:id — editar (manage: messaging:manage) ───────────────────────────
  router.put(
    '/:id',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const parsed = updateBodySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: 'at least one of shortcut or content must be provided (non-empty strings)',
            code: 'VALIDATION_ERROR',
          });
          return;
        }
        const updated = await updateCannedResponse.execute(req.params['id'] as string, {
          shortcut: parsed.data.shortcut,
          content: parsed.data.content,
        });
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── DELETE /:id — borrar (manage: messaging:manage) ────────────────────────
  router.delete(
    '/:id',
    auth,
    perms.manage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await deleteCannedResponse.execute(req.params['id'] as string);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
