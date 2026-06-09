import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { ListTaskInventorySuggestions } from '@application/use-cases/ListTaskInventorySuggestions';
import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { CorrectConfirmedDeviceType } from '@application/use-cases/CorrectConfirmedDeviceType';
import { DiscardInventorySuggestion } from '@application/use-cases/DiscardInventorySuggestion';
import { ListContractInstalledItems } from '@application/use-cases/ListContractInstalledItems';
import { ListClientEquipment } from '@application/use-cases/ListClientEquipment';
import { AddInstalledItemManually } from '@application/use-cases/AddInstalledItemManually';
import { UpdateInstalledItem } from '@application/use-cases/UpdateInstalledItem';
import { RemoveInstalledItem } from '@application/use-cases/RemoveInstalledItem';
import { RecordMaterialConsumption } from '@application/use-cases/RecordMaterialConsumption';
import { ListTaskMaterialConsumptions } from '@application/use-cases/ListTaskMaterialConsumptions';
import { DeleteMaterialConsumption } from '@application/use-cases/DeleteMaterialConsumption';
import { CreateManualSuggestion } from '@application/use-cases/CreateManualSuggestion';
import { DeviceTypeCatalogService } from '@application/services/DeviceTypeCatalogService';
import {
  InstalledItemNotFoundError,
  MaterialConsumptionNotFoundError,
  MaterialNotFoundError,
  InvalidQuantityError,
  SuggestionNotFoundError,
  SuggestionNotConfirmedError,
  NotADeviceError,
  SuggestionNotLinkedError,
} from '@domain/errors/inventory';
import { DomainError } from '@domain/errors/index';
import { z } from 'zod';

/**
 * Granular permission guards (one per route group). Built in app.ts from
 * `requirePerm(module, action)`. Task-scoped routes use the `scheduling` module;
 * contract inventory routes use `inventory` (migrated from `clients`).
 * Reads require `read`, mutations require `write`.
 */
export interface InventoryRoutePerms {
  taskRead: RequestHandler;       // scheduling.read  (suggestions — NOT changed)
  taskWrite: RequestHandler;      // scheduling.write (suggestions — NOT changed)
  contractRead: RequestHandler;   // inventory.read   (was clients.read)
  contractWrite: RequestHandler;  // inventory.write  (was clients.write)
  materialWrite: RequestHandler;  // inventory.write  (NEW — material consumption mutations)
  manage: RequestHandler;         // inventory.manage (admin — correct confirmed device type)
}

const RecordConsumptionSchema = z.object({
  materialCatalogId: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().nullish(),
  notes: z.string().nullish(),
});

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
  correctType: CorrectConfirmedDeviceType,
  listInstalled: ListContractInstalledItems,
  listClientEquipment: ListClientEquipment,
  addManual: AddInstalledItemManually,
  updateItem: UpdateInstalledItem,
  removeItem: RemoveInstalledItem,
  recordConsumption: RecordMaterialConsumption,
  listConsumptions: ListTaskMaterialConsumptions,
  deleteConsumption: DeleteMaterialConsumption,
  auth: RequestHandler,
  perms: InventoryRoutePerms,
  deviceTypes: DeviceTypeCatalogService,
  createManualSuggestion: CreateManualSuggestion,
): Router {
  const router = Router();
  const userId = (req: Request): string | null => (req as { user?: { id?: string } }).user?.id ?? null;

  // ── Task-scoped staging (the operator's checkboxes) ───────────────────────
  router.get('/scheduling/:taskId/inventory/suggestions', auth, perms.taskRead, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listSuggestions.execute(req.params.taskId));
    } catch (e) { next(e); }
  });

  // ── Crear sugerencia manual ───────────────────────────────────────────────
  const CreateManualSuggestionSchema = z.object({
    kind: z.enum(['DEVICE', 'MATERIAL']),
    type: z.string().optional(),
    serialNumber: z.string().nullish(),
    mac: z.string().nullish(),
    materialDesc: z.string().nullish(),
    quantity: z.number().positive().nullish(),
    unit: z.string().nullish(),
  });

  router.post('/scheduling/:taskId/inventory/suggestions', auth, perms.materialWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateManualSuggestionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const dto = await createManualSuggestion.execute({
        taskId: req.params.taskId,
        kind: parsed.data.kind,
        type: parsed.data.type ?? null,
        serialNumber: parsed.data.serialNumber ?? null,
        mac: parsed.data.mac ?? null,
        materialDesc: parsed.data.materialDesc ?? null,
        quantity: parsed.data.quantity ?? null,
        unit: parsed.data.unit ?? null,
      });
      res.status(201).json(dto);
    } catch (e) { next(e); }
  });

  const ConfirmSchema = z.object({
    type: z.string().optional(),
    // 'replace' is intentionally absent — it must go through the dedicated replace route.
    // Sending resolution='replace' here returns 400 VALIDATION_ERROR (zod rejects unknown enum value).
    resolution: z.enum(['add', 'link_existing']).optional(),
  });

  router.post('/scheduling/:taskId/inventory/suggestions/:suggestionId/confirm', auth, perms.taskWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ConfirmSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const rawType = parsed.data.type;
      if (rawType !== undefined && !(await deviceTypes.isValid(rawType))) {
        res.status(422).json({ error: 'Invalid item type override', code: 'INVALID_ITEM_TYPE' });
        return;
      }
      const result = await confirm.execute({
        suggestionId: req.params.suggestionId,
        addedByUserId: userId(req),
        typeOverride: rawType ?? null,
        resolution: parsed.data.resolution ?? 'add',
      });
      res.status(201).json(result);
    } catch (e) { next(e); }
  });

  const ReplaceSchema = z.object({
    type: z.string().optional(),
  });

  router.post('/scheduling/:taskId/inventory/suggestions/:suggestionId/replace', auth, perms.contractWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ReplaceSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const rawType = parsed.data.type;
      if (rawType !== undefined && !(await deviceTypes.isValid(rawType))) {
        res.status(422).json({ error: 'Invalid item type override', code: 'INVALID_ITEM_TYPE' });
        return;
      }
      const result = await confirm.replace({
        suggestionId: req.params.suggestionId,
        addedByUserId: userId(req),
        typeOverride: rawType ?? null,
      });
      res.status(201).json(result);
    } catch (e) { next(e); }
  });

  router.post('/scheduling/:taskId/inventory/suggestions/:suggestionId/discard', auth, perms.taskWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await discard.execute(req.params.suggestionId));
    } catch (e) { next(e); }
  });

  router.patch('/scheduling/:taskId/inventory/suggestions/:suggestionId/type', auth, perms.manage, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawType = (req.body as { type?: unknown } | undefined)?.type;
      if (!(await deviceTypes.isValid(rawType as string))) {
        res.status(422).json({ error: 'Invalid item type', code: 'INVALID_ITEM_TYPE' });
        return;
      }
      const item = await correctType.execute({
        suggestionId: req.params.suggestionId,
        newType: (rawType as string).toUpperCase(),
      });
      res.json(item);
    } catch (e) {
      if (e instanceof SuggestionNotConfirmedError || e instanceof NotADeviceError || e instanceof SuggestionNotLinkedError) {
        res.status(409).json({ error: (e as DomainError).message, code: (e as DomainError).code });
        return;
      }
      if (e instanceof SuggestionNotFoundError || e instanceof InstalledItemNotFoundError) {
        res.status(404).json({ error: (e as DomainError).message, code: (e as DomainError).code });
        return;
      }
      next(e);
    }
  });

  // ── Task-scoped material consumption ──────────────────────────────────────
  router.get('/scheduling/:taskId/inventory/materials', auth, perms.taskRead, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listConsumptions.execute(req.params.taskId));
    } catch (e) { next(e); }
  });

  router.post('/scheduling/:taskId/inventory/materials', auth, perms.materialWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RecordConsumptionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const c = await recordConsumption.execute({
        taskId: req.params.taskId,
        materialCatalogId: parsed.data.materialCatalogId,
        quantity: parsed.data.quantity,
        unit: parsed.data.unit ?? null,
        notes: parsed.data.notes ?? null,
        recordedByUserId: userId(req),
      });
      res.status(201).json(c);
    } catch (e) {
      if (e instanceof MaterialNotFoundError) {
        (res as Response).status(404).json({ error: (e as MaterialNotFoundError).message, code: (e as MaterialNotFoundError).code });
        return;
      }
      if (e instanceof InvalidQuantityError) {
        (res as Response).status(422).json({ error: (e as InvalidQuantityError).message, code: (e as InvalidQuantityError).code });
        return;
      }
      next(e);
    }
  });

  router.delete('/scheduling/:taskId/inventory/materials/:id', auth, perms.materialWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteConsumption.execute(req.params.id);
      res.status(204).send();
    } catch (e) {
      if (e instanceof MaterialConsumptionNotFoundError) {
        (res as Response).status(404).json({ error: (e as MaterialConsumptionNotFoundError).message, code: (e as MaterialConsumptionNotFoundError).code });
        return;
      }
      next(e);
    }
  });

  // ── Contract inventory ─────────────────────────────────────────────────────
  router.get('/contracts/:contractId/inventory', auth, perms.contractRead, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listInstalled.execute(req.params.contractId));
    } catch (e) { next(e); }
  });

  // ── Client equipment (vista agregada read-only, EPIC #38 W2) ────────────────
  // Mismo guard que el inventario por contrato: inventory.read (perms.contractRead).
  router.get('/clients/:clientId/equipment', auth, perms.contractRead, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listClientEquipment.execute(req.params.clientId));
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
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Validate type if provided — mirrors POST validation (DIP: route is the validation boundary)
      if (body.type !== undefined) {
        if (!(await deviceTypes.isValid(body.type as string))) {
          res.status(422).json({ error: 'Invalid item type', code: 'INVALID_ITEM_TYPE' });
          return;
        }
      }
      const item = await updateItem.execute(req.params.itemId, body as Record<string, never>);
      if (!item) {
        res.status(404).json({ error: 'Installed item not found', code: 'INSTALLED_ITEM_NOT_FOUND' });
        return;
      }
      res.json(item);
    } catch (e) { next(e); }
  });

  router.delete('/contracts/:contractId/inventory/:itemId', auth, perms.contractWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const removed = await removeItem.execute(req.params.itemId);
      res.json(removed);
    } catch (e) {
      if (e instanceof InstalledItemNotFoundError) {
        (res as Response).status(404).json({ error: (e as InstalledItemNotFoundError).message, code: (e as InstalledItemNotFoundError).code });
        return;
      }
      next(e);
    }
  });

  return router;
}
