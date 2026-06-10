import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { GetTechnicianStock } from '@application/use-cases/GetTechnicianStock';
import { IssueStockToTechnician } from '@application/use-cases/IssueStockToTechnician';
import { ListPendingReturns } from '@application/use-cases/ListPendingReturns';
import { ConfirmAssetReturn } from '@application/use-cases/ConfirmAssetReturn';
import { ListPendingDeductions } from '@application/use-cases/ListPendingDeductions';
import { ConfirmMaterialDeduction } from '@application/use-cases/ConfirmMaterialDeduction';
// EPIC #38 W5b — vehicle stock
import { GetVehicleStock } from '@application/use-cases/GetVehicleStock';
import { IssueStockToVehicle } from '@application/use-cases/IssueStockToVehicle';
// Wave 7 (Capstone) — dashboard use cases
import { GetInventoryOverview } from '@application/use-cases/GetInventoryOverview';
import { ListInventoryMovements } from '@application/use-cases/ListInventoryMovements';
import { GetLowStockAlerts } from '@application/use-cases/GetLowStockAlerts';
// EPIC #38 follow-up — depot stock entry
import { AddAssetToDepot } from '@application/use-cases/AddAssetToDepot';
import { AddMaterialToDepot } from '@application/use-cases/AddMaterialToDepot';
// FIX B — technician list endpoint
import { ListTechniciansWithStock } from '@application/use-cases/ListTechniciansWithStock';
// FIX C — return suggestions by task
import { ListReturnSuggestionsByTask } from '@application/use-cases/ListReturnSuggestionsByTask';
import {
  ReturnSuggestionNotFoundError,
  ReturnAlreadyResolvedError,
  ReturnHasNoAssetError,
  AssetNotReturnableError,
  DeductionSuggestionNotFoundError,
  DeductionAlreadyConfirmedError,
  DeductionHasNoTechnicianError,
  InsufficientStockError,
  VehicleNotFoundError,
  VehicleInactiveError,
  AssetNotAtDepotError,
  AssetAlreadyExistsError,
  AssetIdentifierRequiredError,
  DeviceTypeNotFoundError,
  MaterialNotFoundError,
  InvalidQuantityError,
} from '@domain/errors/inventory';
import { DomainError } from '@domain/errors/index';
import { z } from 'zod';

/**
 * Inventory depot + returns surface (EPIC #38, Waves 3 + 4 + 6). Mounted at `/api/inventory`.
 *
 * - `GET /depot` → read-only DEPOSITO stock (W3), `inventory.read`.
 * - `GET /returns/pending` → return suggestions awaiting an operator (W4), `inventory.read`.
 * - `POST /returns/:id/confirm` → resolve a suggestion (return/link/create/discard) — the
 *    ONLY stock mutation path (W4), `inventory.write`.
 * - `POST /returns/:id/discard` → convenience discard (W4), `inventory.write`.
 * - `GET /technicians/:id/stock` → read-only technician stock (W5a), `inventory.read`.
 * - `POST /technicians/:id/issue` → issue (TRANSFER) stock depot→technician (W5a), `inventory.write`.
 * - `GET /deductions/pending` → material deduction suggestions awaiting operator (W6), `inventory.read`.
 * - `POST /deductions/:id/confirm` → operator resolves a deduction suggestion (W6), `inventory.write`.
 * - `POST /deductions/:id/discard` → convenience discard for deduction (W6), `inventory.write`.
 *
 * Use cases never mutate raw entities and never return them — DTOs only.
 */
/**
 * Accepts either a full ISO datetime (`2026-06-09T00:00:00.000Z`) or a bare
 * date string (`2026-06-09`). Bare dates are validated strictly (month 01-12,
 * day 01-31) and then normalized to UTC boundary:
 *   dateFrom → `T00:00:00.000Z` (start of day)
 *   dateTo   → `T23:59:59.999Z` (end of day)
 * so that picking the same day for both inputs returns all movements on that day.
 * Garbage input (`abc`, `2026-13-99`) produces a Zod validation failure → 400.
 */
const BARE_DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function parseDateParam(val: string, side: 'from' | 'to'): string {
  if (BARE_DATE_RE.test(val)) {
    return side === 'from' ? `${val}T00:00:00.000Z` : `${val}T23:59:59.999Z`;
  }
  // Full ISO datetime — pass through (Zod .datetime() will validate below if we get here)
  return val;
}

/**
 * Wave 7 (Capstone) — Zod schema for the movement ledger query string.
 * page ≥ 1, limit 1-100, type optional enum, other filters optional strings.
 * Accepts both full ISO datetime AND bare YYYY-MM-DD for dateFrom/dateTo.
 * Returns 400 on validation failure.
 */
const MovementsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum(['ISSUE', 'TRANSFER', 'INSTALL', 'RETURN', 'CONSUME', 'ADJUST']).optional(),
  locationId: z.string().min(1).optional(),
  materialCatalogId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  technicianId: z.string().min(1).optional(),
  dateFrom: z.string()
    .optional()
    .refine(
      (v) => v === undefined || BARE_DATE_RE.test(v) || z.string().datetime().safeParse(v).success,
      { message: 'dateFrom must be YYYY-MM-DD or a full ISO datetime string' },
    )
    .transform((v) => (v !== undefined ? parseDateParam(v, 'from') : v)),
  dateTo: z.string()
    .optional()
    .refine(
      (v) => v === undefined || BARE_DATE_RE.test(v) || z.string().datetime().safeParse(v).success,
      { message: 'dateTo must be YYYY-MM-DD or a full ISO datetime string' },
    )
    .transform((v) => (v !== undefined ? parseDateParam(v, 'to') : v)),
});

export function createInventoryRouter(
  getDepotStock: GetDepotStock,
  listPendingReturns: ListPendingReturns,
  confirmAssetReturn: ConfirmAssetReturn,
  getTechnicianStock: GetTechnicianStock,
  issueStockToTechnician: IssueStockToTechnician,
  auth: RequestHandler,
  requireRead: RequestHandler,
  requireWrite: RequestHandler,
  // W6 — optional; when omitted the /deductions routes are not registered.
  listPendingDeductions?: ListPendingDeductions,
  confirmMaterialDeduction?: ConfirmMaterialDeduction,
  // EPIC #38 W5b — vehicle stock routes (appended at END per W6 ordering rule)
  getVehicleStock?: GetVehicleStock,
  issueStockToVehicle?: IssueStockToVehicle,
  // Wave 7 (Capstone) — dashboard routes (appended LAST per W6 ordering rule)
  getInventoryOverview?: GetInventoryOverview,
  listInventoryMovements?: ListInventoryMovements,
  getLowStockAlerts?: GetLowStockAlerts,
  // EPIC #38 follow-up — depot stock entry routes (optional; omitted in legacy wiring)
  addAssetToDepot?: AddAssetToDepot,
  addMaterialToDepot?: AddMaterialToDepot,
  // FIX B — technician list (optional; omitted when not wired)
  listTechniciansWithStock?: ListTechniciansWithStock,
  // FIX C — return suggestions by task (optional; omitted when not wired)
  listReturnSuggestionsByTask?: ListReturnSuggestionsByTask,
): Router {
  const router = Router();

  router.get('/depot', auth, requireRead, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getDepotStock.execute());
    } catch (e) {
      next(e);
    }
  });

  // ── EPIC #38 follow-up — depot stock entry ─────────────────────────────────
  if (addAssetToDepot) {
    const AssetEntrySchema = z.object({
      deviceTypeId: z.string().min(1),
      serialNumber: z.string().nullish(),
      mac: z.string().nullish(),
      note: z.string().nullish(),
    });

    router.post('/depot/assets', auth, requireWrite, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = AssetEntrySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        const dto = await addAssetToDepot.execute({
          deviceTypeId: parsed.data.deviceTypeId,
          serialNumber: parsed.data.serialNumber ?? null,
          mac: parsed.data.mac ?? null,
          note: parsed.data.note ?? null,
        });
        res.status(201).json(dto);
      } catch (e) {
        handleDepotEntryError(e, res, next);
      }
    });
  }

  if (addMaterialToDepot) {
    const MaterialEntrySchema = z.object({
      materialCatalogId: z.string().min(1),
      qty: z.number().positive(),
      note: z.string().nullish(),
    });

    router.post('/depot/materials', auth, requireWrite, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = MaterialEntrySchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        const dto = await addMaterialToDepot.execute({
          materialCatalogId: parsed.data.materialCatalogId,
          qty: parsed.data.qty,
          note: parsed.data.note ?? null,
        });
        res.status(200).json(dto);
      } catch (e) {
        handleDepotEntryError(e, res, next);
      }
    });
  }

  // ── FIX B — technician list (GET /technicians — inventory.read) ───────────
  // Returns all active users with their TECNICO stock summary.
  // MUST be mounted BEFORE /technicians/:id/* to avoid /:id catching "technicians".
  if (listTechniciansWithStock) {
    router.get('/technicians', auth, requireRead, async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await listTechniciansWithStock.execute());
      } catch (e) {
        next(e);
      }
    });
  }

  // ── EPIC #38 W4 — closure-detected returns ────────────────────────────────
  router.get('/returns/pending', auth, requireRead, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listPendingReturns.execute());
    } catch (e) {
      next(e);
    }
  });

  // ── FIX C — return suggestions by task ────────────────────────────────────
  // MUST be mounted BEFORE /returns/:id/* to avoid /:id swallowing "by-task".
  if (listReturnSuggestionsByTask) {
    router.get('/returns/by-task/:taskId', auth, requireRead, async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await listReturnSuggestionsByTask.execute(req.params.taskId));
      } catch (e) {
        next(e);
      }
    });
  }

  const ConfirmSchema = z.object({
    resolution: z.enum(['return', 'link', 'create', 'discard']),
    linkedAssetId: z.string().min(1).nullish(),
  });

  router.post('/returns/:id/confirm', auth, requireWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ConfirmSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      const dto = await confirmAssetReturn.execute({
        suggestionId: req.params.id,
        resolution: parsed.data.resolution,
        linkedAssetId: parsed.data.linkedAssetId ?? null,
        confirmedByUserId: (req as { user?: { id?: string } }).user?.id ?? null,
      });
      res.status(200).json(dto);
    } catch (e) {
      handleReturnError(e, res, next);
    }
  });

  router.post('/returns/:id/discard', auth, requireWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dto = await confirmAssetReturn.execute({
        suggestionId: req.params.id,
        resolution: 'discard',
        confirmedByUserId: (req as { user?: { id?: string } }).user?.id ?? null,
      });
      res.status(200).json(dto);
    } catch (e) {
      handleReturnError(e, res, next);
    }
  });

  // ── EPIC #38 W5a — technician stock ────────────────────────────────────────
  router.get('/technicians/:id/stock', auth, requireRead, async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getTechnicianStock.execute(req.params.id));
    } catch (e) {
      next(e);
    }
  });

  // An issue line is EITHER an asset OR a material+qty (XOR — same shape as a movement).
  const IssueItemSchema = z.union([
    z.object({ assetId: z.string().min(1) }).strict(),
    z.object({ materialCatalogId: z.string().min(1), qty: z.number().positive() }).strict(),
  ]);
  const IssueSchema = z.object({ items: z.array(IssueItemSchema).min(1) });

  router.post('/technicians/:id/issue', auth, requireWrite, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = IssueSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
        return;
      }
      await issueStockToTechnician.execute(req.params.id, { items: parsed.data.items });
      res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ── EPIC #38 W6 — material deduction suggestions ─────────────────────────
  if (listPendingDeductions && confirmMaterialDeduction) {
    router.get(
      '/deductions/pending',
      auth,
      requireRead,
      async (_req: Request, res: Response, next: NextFunction) => {
        try {
          res.json(await listPendingDeductions.execute());
        } catch (e) {
          next(e);
        }
      },
    );

    const DeductionConfirmSchema = z.object({
      resolution: z.enum(['deduct', 'issue-first', 'depot', 'discard']),
    });

    router.post(
      '/deductions/:id/confirm',
      auth,
      requireWrite,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const parsed = DeductionConfirmSchema.safeParse(req.body ?? {});
          if (!parsed.success) {
            res.status(400).json({
              error: 'Validation error',
              code: 'VALIDATION_ERROR',
              details: parsed.error.issues,
            });
            return;
          }
          const dto = await confirmMaterialDeduction.execute({
            suggestionId: req.params.id,
            resolution: parsed.data.resolution,
          });
          res.status(200).json(dto);
        } catch (e) {
          handleDeductionError(e, res, next);
        }
      },
    );

    router.post(
      '/deductions/:id/discard',
      auth,
      requireWrite,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const dto = await confirmMaterialDeduction.execute({
            suggestionId: req.params.id,
            resolution: 'discard',
          });
          res.status(200).json(dto);
        } catch (e) {
          handleDeductionError(e, res, next);
        }
      },
    );
  }

  // ── EPIC #38 W5b — vehicle stock ────────────────────────────────────────────
  if (getVehicleStock && issueStockToVehicle) {
    router.get('/vehicles/:id/stock', auth, requireRead, async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await getVehicleStock.execute(req.params.id));
      } catch (e) {
        handleVehicleIssueError(e, res, next);
      }
    });

    router.post('/vehicles/:id/issue', auth, requireWrite, async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = IssueSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }
        await issueStockToVehicle.execute(req.params.id, { items: parsed.data.items });
        res.status(200).json({ ok: true });
      } catch (e) {
        handleVehicleIssueError(e, res, next);
      }
    });
  }

  // ── Wave 7 (Capstone) — dashboard read routes ────────────────────────────────
  if (getInventoryOverview && listInventoryMovements && getLowStockAlerts) {
    router.get(
      '/overview/locations',
      auth,
      requireRead,
      async (_req: Request, res: Response, next: NextFunction) => {
        try {
          res.json(await getInventoryOverview.execute());
        } catch (e) {
          next(e);
        }
      },
    );

    router.get(
      '/movements',
      auth,
      requireRead,
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const parsed = MovementsQuery.safeParse(req.query);
          if (!parsed.success) {
            res.status(400).json({
              error: 'Validation error',
              code: 'VALIDATION_ERROR',
              details: parsed.error.issues,
            });
            return;
          }
          const { page, limit, type, locationId, materialCatalogId, taskId, technicianId, dateFrom, dateTo } = parsed.data;
          const result = await listInventoryMovements.execute(
            { type, locationId, materialCatalogId, taskId, technicianId, dateFrom, dateTo },
            page,
            limit,
          );
          res.json(result);
        } catch (e) {
          next(e);
        }
      },
    );

    router.get(
      '/alerts',
      auth,
      requireRead,
      async (_req: Request, res: Response, next: NextFunction) => {
        try {
          res.json(await getLowStockAlerts.execute());
        } catch (e) {
          next(e);
        }
      },
    );
  }

  return router;
}

/**
 * Maps depot stock entry domain errors to HTTP.
 * 400 → validation / qty / identifier-required.
 * 404 → deviceType or material not found.
 * 409 → asset already exists (duplicate serial/mac).
 */
function handleDepotEntryError(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof AssetIdentifierRequiredError || e instanceof InvalidQuantityError) {
    res.status(400).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  if (e instanceof DeviceTypeNotFoundError || e instanceof MaterialNotFoundError) {
    res.status(404).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  if (e instanceof AssetAlreadyExistsError) {
    res.status(409).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  // FIX 2b: DB backstop — concurrent creation wins the race and hits the unique constraint
  // (serialNumber or mac partial unique). P2002 propagates as a raw Prisma error from inside
  // the UoW tx (no recovery possible on a poisoned tx client). Map it to 409.
  if (e && typeof e === 'object' && (e as { code?: string }).code === 'P2002') {
    res.status(409).json({ error: 'Asset already exists', code: 'ASSET_ALREADY_EXISTS' });
    return;
  }
  next(e);
}

/**
 * Maps W5b vehicle issue domain errors to HTTP.
 */
function handleVehicleIssueError(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof VehicleNotFoundError) {
    res.status(404).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  if (e instanceof VehicleInactiveError) {
    res.status(422).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  if (e instanceof AssetNotAtDepotError) {
    res.status(409).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  if (e instanceof InsufficientStockError) {
    res.status(409).json({ error: (e as DomainError).message, code: 'INSUFFICIENT_DEPOT_STOCK' });
    return;
  }
  next(e);
}

/**
 * Maps W6 deduction domain errors to HTTP.
 * 404 → suggestion not found.
 * 409 → already confirmed/discarded, or L2 sourceRef collision (P2002 race).
 */
function handleDeductionError(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof DeductionSuggestionNotFoundError) {
    res.status(404).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  if (e instanceof DeductionAlreadyConfirmedError) {
    res.status(409).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  // Fix 3c: depot=0 confirm → InsufficientStockError → 409 (not 500).
  if (e instanceof InsufficientStockError) {
    res.status(409).json({ error: (e as DomainError).message, code: 'INSUFFICIENT_STOCK' });
    return;
  }
  // Fix 5: issue-first with null technicianLocationId → 409 (not 500).
  if (e instanceof DeductionHasNoTechnicianError) {
    res.status(409).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  // L2 race: concurrent CONSUME hits the sourceRef partial unique (P2002) → 409.
  if (e && typeof e === 'object' && (e as { code?: string }).code === 'P2002') {
    res.status(409).json({
      error: 'This material deduction has already been confirmed',
      code: 'DEDUCTION_ALREADY_CONFIRMED',
    });
    return;
  }
  next(e);
}

/**
 * Maps W4 return domain errors to HTTP: 404 not-found, 409 conflict (already-resolved /
 * no-asset / not-returnable / a true sourceRef race loser P2002).
 */
function handleReturnError(e: unknown, res: Response, next: NextFunction): void {
  if (e instanceof ReturnSuggestionNotFoundError) {
    res.status(404).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  if (
    e instanceof ReturnAlreadyResolvedError ||
    e instanceof ReturnHasNoAssetError ||
    e instanceof AssetNotReturnableError
  ) {
    res.status(409).json({ error: (e as DomainError).message, code: (e as DomainError).code });
    return;
  }
  // Fix #2: a true concurrent race loser hits the sourceRef PARTIAL UNIQUE (P2002) inside
  // the aborted tx and propagates the raw Prisma error — map it to a clean 409, not a 500.
  if (e && typeof e === 'object' && (e as { code?: string }).code === 'P2002') {
    res.status(409).json({ error: 'This asset has already been returned', code: 'RETURN_ALREADY_RESOLVED' });
    return;
  }
  next(e);
}
