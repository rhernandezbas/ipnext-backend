import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ListTaskInventorySuggestions } from '@application/use-cases/ListTaskInventorySuggestions';
import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListServiceInstalledItems } from '@application/use-cases/ListServiceInstalledItems';
import { AddInstalledItemManually } from '@application/use-cases/AddInstalledItemManually';
import { UpdateInstalledItem } from '@application/use-cases/UpdateInstalledItem';
import { InstalledItemType } from '@domain/entities/service-installed-item';

const VALID_TYPES: InstalledItemType[] = ['ONU', 'ROUTER', 'ANTENA', 'REPETIDOR', 'OTROS'];

/**
 * Granular permission guards (one per route group). Built in app.ts from
 * `requirePerm(module, action)`. Task-scoped routes use the `scheduling` module
 * and contract routes the `clients` module — matching the FE's `Can`/`RequirePermission`
 * keys (scheduling.* / clients.*). Reads require `read`, mutations require `write`.
 */
export interface InventoryRoutePerms {
  taskRead: RequestHandler;
  taskWrite: RequestHandler;
  serviceRead: RequestHandler;
  serviceWrite: RequestHandler;
}

/**
 * IClass closure → inventory HTTP surface. Mounted at `/api`; task-scoped
 * suggestion endpoints under `/scheduling/:taskId/...`, contract inventory under
 * `/services/:serviceId/...`. Mounted BEFORE the `/api/scheduling` `/:id` catch-all.
 * Every route is `auth` (authenticated) + a granular `requirePerm` guard.
 */
export function createServiceInventoryRouter(
  listSuggestions: ListTaskInventorySuggestions,
  confirm: ConfirmInventorySuggestion,
  discard: DiscardInventorySuggestion,
  listInstalled: ListServiceInstalledItems,
  addManual: AddInstalledItemManually,
  updateItem: UpdateInstalledItem,
  auth: RequestHandler,
  perms: InventoryRoutePerms,
): Router {
  const router = Router();
  const userId = (req: Request): string | null => (req as { user?: { id?: string } }).user?.id ?? null;

  // ── Task-scoped staging (the operator's checkboxes) ───────────────────────
  router.get('/scheduling/:taskId/inventory/suggestions', auth, perms.taskRead, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listSuggestions.execute(req.params.taskId));
    } catch (e) { next(e); }
  });

  router.post('/scheduling/:taskId/inventory/suggestions/:suggestionId/confirm', auth, perms.taskWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const item = await confirm.execute({ suggestionId: req.params.suggestionId, addedByUserId: userId(req) });
      res.status(201).json(item);
    } catch (e) { next(e); }
  });

  router.post('/scheduling/:taskId/inventory/suggestions/:suggestionId/discard', auth, perms.taskWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await discard.execute(req.params.suggestionId));
    } catch (e) { next(e); }
  });

  // ── Contract (Service) inventory ──────────────────────────────────────────
  router.get('/services/:serviceId/inventory', auth, perms.serviceRead, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listInstalled.execute(req.params.serviceId));
    } catch (e) { next(e); }
  });

  router.post('/services/:serviceId/inventory', auth, perms.serviceWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const type = body.type as InstalledItemType;
      if (!VALID_TYPES.includes(type)) {
        res.status(422).json({ error: 'Invalid or missing item type', code: 'INVALID_ITEM_TYPE' });
        return;
      }
      const item = await addManual.execute({
        serviceId: req.params.serviceId,
        type,
        serialNumber: (body.serialNumber as string) ?? null,
        mac: (body.mac as string) ?? null,
        model: (body.model as string) ?? null,
        notes: (body.notes as string) ?? null,
        addedByUserId: userId(req),
      });
      res.status(201).json(item);
    } catch (e) { next(e); }
  });

  router.patch('/services/:serviceId/inventory/:itemId', auth, perms.serviceWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const item = await updateItem.execute(req.params.itemId, (req.body ?? {}) as Record<string, never>);
      if (!item) {
        res.status(404).json({ error: 'Installed item not found', code: 'INSTALLED_ITEM_NOT_FOUND' });
        return;
      }
      res.json(item);
    } catch (e) { next(e); }
  });

  return router;
}
