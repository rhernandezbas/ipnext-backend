import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { GetTechnicianStock } from '@application/use-cases/GetTechnicianStock';
import { IssueStockToTechnician } from '@application/use-cases/IssueStockToTechnician';
import { ListPendingReturns } from '@application/use-cases/ListPendingReturns';
import { ConfirmAssetReturn } from '@application/use-cases/ConfirmAssetReturn';
import { ListPendingDeductions } from '@application/use-cases/ListPendingDeductions';
import { ConfirmMaterialDeduction } from '@application/use-cases/ConfirmMaterialDeduction';
import {
  ReturnSuggestionNotFoundError,
  ReturnAlreadyResolvedError,
  ReturnHasNoAssetError,
  AssetNotReturnableError,
  DeductionSuggestionNotFoundError,
  DeductionAlreadyConfirmedError,
  DeductionHasNoTechnicianError,
  InsufficientStockError,
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
): Router {
  const router = Router();

  router.get('/depot', auth, requireRead, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await getDepotStock.execute());
    } catch (e) {
      next(e);
    }
  });

  // ── EPIC #38 W4 — closure-detected returns ────────────────────────────────
  router.get('/returns/pending', auth, requireRead, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await listPendingReturns.execute());
    } catch (e) {
      next(e);
    }
  });

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

  return router;
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
