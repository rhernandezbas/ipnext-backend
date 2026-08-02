import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ListNotifications } from '@application/use-cases/ListNotifications';
import { MarkNotificationRead } from '@application/use-cases/MarkNotificationRead';
import { MarkAllNotificationsRead } from '@application/use-cases/MarkAllNotificationsRead';
import { DeleteNotification } from '@application/use-cases/DeleteNotification';
import { SendPushServiceAlert } from '@application/use-cases/notifications/SendPushServiceAlert';
import { PreviewPushServiceAlert } from '@application/use-cases/notifications/PreviewPushServiceAlert';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection, molde promos.routes.ts). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * portal-push-notifications — `sendPushServiceAlert`/`previewPushServiceAlert`
 * son OPCIONALES (mismo criterio "cuando faltan, la ruta no se monta" que
 * `PortalRouterDeps`) para no romper callers/tests existentes que wireaban
 * este router con solo los 4 use cases originales del bell icon interno.
 * Cuando SÍ vienen, `authProvider`/`requirePerm` pasan a ser obligatorios
 * (no tiene sentido montar una ruta de alto riesgo sin guard).
 */
export function createNotificationsRouter(
  listNotifications: ListNotifications,
  markRead: MarkNotificationRead,
  markAllRead: MarkAllNotificationsRead,
  deleteNotification: DeleteNotification,
  authProvider?: AuthProvider,
  sessionRepo?: SessionRepository,
  requirePerm?: RequirePerm,
  sendPushServiceAlert?: SendPushServiceAlert,
  previewPushServiceAlert?: PreviewPushServiceAlert,
): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const unread = req.query['unread'] === 'true';
      const notifications = await listNotifications.execute(unread || undefined);
      res.json(notifications);
    } catch (err) {
      next(err);
    }
  });

  router.put('/read-all', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await markAllRead.execute();
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id/read', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const notification = await markRead.execute(req.params['id'] as string);
      if (!notification) {
        res.status(404).json({ error: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' });
        return;
      }
      res.json(notification);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const deleted = await deleteNotification.execute(req.params['id'] as string);
      if (!deleted) {
        res.status(404).json({ error: 'Notification not found', code: 'NOTIFICATION_NOT_FOUND' });
        return;
      }
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ── portal-push-notifications — avisos de servicio (admin, push.send) ──────
  // A DIFERENCIA de las rutas de arriba (bell icon interno, sin guard — ver el
  // docblock del módulo), estas DOS rutas llevan `auth` + `requirePerm` POR
  // RUTA: mandar un push a TODOS los clientes de un nodo es una acción de alto
  // alcance, no una lectura de notificaciones internas.
  //
  // Envío de PROMOCIONES queda explícitamente FUERA de este change (proposal
  // "Out of Scope" + instrucción de la fase backend): `PortalPushPreference.
  // promos` YA existe y es auditable, pero nada la usa para enviar todavía —
  // sale en una fase siguiente, cuando el lado app de la app de clientes exista.
  if (authProvider && requirePerm && sendPushServiceAlert && previewPushServiceAlert) {
    const auth = createAuthMiddleware(authProvider, sessionRepo);
    const sendPerm = requirePerm('push', 'send');

    function parsePushServiceAlertBody(
      req: Request,
      res: Response,
    ): { title: string; body: string; networkSiteId?: string | null } | undefined {
      const raw = (req.body ?? {}) as { title?: unknown; body?: unknown; networkSiteId?: unknown };
      if (typeof raw.title !== 'string' || !raw.title.trim() || typeof raw.body !== 'string' || !raw.body.trim()) {
        res.status(400).json({ error: 'title y body son requeridos', code: 'VALIDATION_ERROR' });
        return undefined;
      }
      if (raw.networkSiteId !== undefined && raw.networkSiteId !== null && typeof raw.networkSiteId !== 'string') {
        res.status(400).json({ error: 'networkSiteId inválido', code: 'VALIDATION_ERROR' });
        return undefined;
      }
      return { title: raw.title, body: raw.body, networkSiteId: (raw.networkSiteId as string | null | undefined) ?? null };
    }

    /**
     * El preview NUNCA manda — no necesita `title`/`body` (esos solo importan
     * para el envío real), únicamente el filtro de segmentación. Validar acá
     * `title`/`body` como en `parsePushServiceAlertBody` rechazaría con 400 un
     * preview legítimo `{}`/`{networkSiteId}` sin esos dos campos.
     */
    function parsePushServiceAlertPreviewBody(req: Request, res: Response): { networkSiteId?: string | null } | undefined {
      const raw = (req.body ?? {}) as { networkSiteId?: unknown };
      if (raw.networkSiteId !== undefined && raw.networkSiteId !== null && typeof raw.networkSiteId !== 'string') {
        res.status(400).json({ error: 'networkSiteId inválido', code: 'VALIDATION_ERROR' });
        return undefined;
      }
      return { networkSiteId: (raw.networkSiteId as string | null | undefined) ?? null };
    }

    // ESTÁTICA, debe preceder a cualquier `:param` futuro de este router (no hay hoy, pero mismo criterio que promos.routes.ts).
    router.post(
      '/push-service-alert/preview',
      auth,
      sendPerm,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const body = parsePushServiceAlertPreviewBody(req, res);
        if (!body) return;
        try {
          const result = await previewPushServiceAlert.execute({ networkSiteId: body.networkSiteId });
          res.json(result);
        } catch (err) {
          next(err);
        }
      },
    );

    router.post(
      '/push-service-alert',
      auth,
      sendPerm,
      async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const body = parsePushServiceAlertBody(req, res);
        if (!body) return;
        try {
          const result = await sendPushServiceAlert.execute(body);
          res.json(result);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  return router;
}
