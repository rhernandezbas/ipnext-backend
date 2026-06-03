import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ListTaskInventorySuggestions } from '@application/use-cases/ListTaskInventorySuggestions';
import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListContractInstalledItems } from '@application/use-cases/ListContractInstalledItems';
import { AddInstalledItemManually } from '@application/use-cases/AddInstalledItemManually';
import { UpdateInstalledItem } from '@application/use-cases/UpdateInstalledItem';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';

/**
 * Granular permission guards (one per route group). Built in app.ts from
 * `requirePerm(module, action)`. Task-scoped routes use the `scheduling` module
 * and contract routes the `clients` module — matching the FE's `Can`/`RequirePermission`
 * keys (scheduling.* / clients.*). Reads require `read`, mutations require `write`.
 */
export interface InventoryRoutePerms {
  taskRead: RequestHandler;
  taskWrite: RequestHandler;
  contractRead: RequestHandler;
  contractWrite: RequestHandler;
}

/**
 * IClass closure → inventory HTTP surface. Mounted at `/api`; task-scoped
 * suggestion endpoints under `/scheduling/:taskId/...`, contract inventory under
 * `/contracts/:contractId/...`. Mounted BEFORE the `/api/scheduling` `/:id` catch-all.
 * Every route is `auth` (authenticated) + a granular `requirePerm` guard.
 *
 * Type validation uses the DeviceTypeCatalogService (dynamic catalog) — unknown
 * types from non-catalog sources → 422 INVALID_ITEM_TYPE.
 */
export function createContractInventoryRouter(
  listSuggestions: ListTaskInventorySuggestions,
  confirm: ConfirmInventorySuggestion,
  discard: DiscardInventorySuggestion,
  listInstalled: ListContractInstalledItems,
  addManual: AddInstalledItemManually,
  updateItem: UpdateInstalledItem,
  auth: RequestHandler,
  perms: InventoryRoutePerms,
  deviceTypes: DeviceTypeCatalogService,
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
      const rawType = (req.body as { type?: unknown } | undefined)?.type;
      if (rawType !== undefined && !(await deviceTypes.isValid(rawType as string))) {
        res.status(422).json({ error: 'Invalid item type override', code: 'INVALID_ITEM_TYPE' });
        return;
      }
      const item = await confirm.execute({
        suggestionId: req.params.suggestionId,
        addedByUserId: userId(req),
        typeOverride: (rawType as string | undefined) ?? null,
      });
      res.status(201).json(item);
    } catch (e) { next(e); }
  });

  router.post('/scheduling/:taskId/inventory/suggestions/:suggestionId/discard', auth, perms.taskWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await discard.execute(req.params.suggestionId));
    } catch (e) { next(e); }
  });

  // ── Contract inventory ─────────────────────────────────────────────────────
  router.get('/contracts/:contractId/inventory', auth, perms.contractRead, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listInstalled.execute(req.params.contractId));
    } catch (e) { next(e); }
  });

  router.post('/contracts/:contractId/inventory', auth, perms.contractWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawType = body.type as string | undefined;
      if (!(await deviceTypes.isValid(rawType))) {
        res.status(422).json({ error: 'Invalid or missing item type', code: 'INVALID_ITEM_TYPE' });
        return;
      }
      const item = await addManual.execute({
        contractId: req.params.contractId,
        type: rawType!,
        serialNumber: (body.serialNumber as string) ?? null,
        mac: (body.mac as string) ?? null,
        model: (body.model as string) ?? null,
        notes: (body.notes as string) ?? null,
        addedByUserId: userId(req),
      });
      res.status(201).json(item);
    } catch (e) { next(e); }
  });

  router.patch('/contracts/:contractId/inventory/:itemId', auth, perms.contractWrite, async (req: Request, res: Response, next: NextFunction) => {
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
