/**
 * Change 3 (templates CRUD, T4) — router `/api/messaging/templates` (VER/CREAR/
 * SUBMIT/BORRAR templates WhatsApp directo a Twilio Content API). NUEVO, NO
 * amplía `messagingBulk.routes.ts` (que es el envío masivo). Molde
 * `messaging.routes.ts`/`messagingBulk.routes.ts`: factory + perms interface,
 * auth aplicada POR RUTA, cada handler async try/catch → `next(err)` (el
 * `errorHandler` global mapea los `DomainError` tipados vía `statusMap`).
 *
 * RBAC doble capa: read (list/get) = `messaging.templates`; write (create/submit/
 * delete) = `messaging.bulk`. Se montan como `perms.templates` / `perms.bulk`.
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { CreateTemplate } from '@application/use-cases/messaging/CreateTemplate';
import { ListTemplates } from '@application/use-cases/messaging/ListTemplates';
import { GetTemplate } from '@application/use-cases/messaging/GetTemplate';
import { SubmitTemplateForApproval } from '@application/use-cases/messaging/SubmitTemplateForApproval';
import { DeleteTemplate } from '@application/use-cases/messaging/DeleteTemplate';
import type { CreateTemplateInput, SubmitTemplateInput } from '@application/dto/messaging-templates.dto';

/** Per-route permission guards. read=`messaging.templates`, write=`messaging.bulk`. */
export interface MessagingTemplatesRoutePerms {
  /** write (create/submit/delete). */
  bulk: RequestHandler;
  /** read (list/get). */
  templates: RequestHandler;
}

export function createMessagingTemplatesRouter(
  createTemplate: CreateTemplate,
  listTemplates: ListTemplates,
  getTemplate: GetTemplate,
  submitTemplate: SubmitTemplateForApproval,
  deleteTemplate: DeleteTemplate,
  auth: RequestHandler,
  perms: MessagingTemplatesRoutePerms,
): Router {
  const router = Router();

  // ─── GET / — listar templates (read: messaging.templates) ──────────────────
  router.get(
    '/',
    auth,
    perms.templates,
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const data = await listTemplates.execute();
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── POST / — crear template (write: messaging.bulk) ───────────────────────
  router.post(
    '/',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const input: CreateTemplateInput = {
          friendlyName: typeof body?.['friendlyName'] === 'string' ? (body['friendlyName'] as string) : '',
          language: typeof body?.['language'] === 'string' ? (body['language'] as string) : '',
          category: typeof body?.['category'] === 'string' ? (body['category'] as string) : undefined,
          body: typeof body?.['body'] === 'string' ? (body['body'] as string) : '',
          variables: Array.isArray(body?.['variables'])
            ? (body!['variables'] as unknown[]).filter((v): v is string => typeof v === 'string')
            : [],
        };
        const created = await createTemplate.execute(input);
        res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /:sid — ver ficha (read: messaging.templates) ─────────────────────
  router.get(
    '/:sid',
    auth,
    perms.templates,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await getTemplate.execute(req.params['sid'] as string);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── POST /:sid/submit — enviar a Meta (write: messaging.bulk) ─────────────
  router.post(
    '/:sid/submit',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const input: SubmitTemplateInput = {
          name: typeof body?.['name'] === 'string' ? (body['name'] as string) : '',
          category: typeof body?.['category'] === 'string' ? (body['category'] as string) : '',
        };
        await submitTemplate.execute(req.params['sid'] as string, input);
        res.status(202).json({ contentSid: req.params['sid'], submitted: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── DELETE /:sid — borrar (write: messaging.bulk + guard campañas activas) ─
  router.delete(
    '/:sid',
    auth,
    perms.bulk,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await deleteTemplate.execute(req.params['sid'] as string);
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
