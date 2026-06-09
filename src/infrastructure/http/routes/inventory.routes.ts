import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { GetDepotStock } from '@application/use-cases/GetDepotStock';
import { GetTechnicianStock } from '@application/use-cases/GetTechnicianStock';
import { IssueStockToTechnician } from '@application/use-cases/IssueStockToTechnician';
import { ListPendingReturns } from '@application/use-cases/ListPendingReturns';
import { ConfirmAssetReturn } from '@application/use-cases/ConfirmAssetReturn';
import {
  ReturnSuggestionNotFoundError,
  ReturnAlreadyResolvedError,
  ReturnHasNoAssetError,
  AssetNotReturnableError,
} from '@domain/errors/inventory';
import { DomainError } from '@domain/errors/index';
import { z } from 'zod';

/**
 * Inventory depot + returns surface (EPIC #38, Waves 3 + 4). Mounted at `/api/inventory`.
 *
 * - `GET /depot` → read-only DEPOSITO stock (W3), `inventory.read`.
 * - `GET /returns/pending` → return suggestions awaiting an operator (W4), `inventory.read`.
 * - `POST /returns/:id/confirm` → resolve a suggestion (return/link/create/discard) — the
 *    ONLY stock mutation path (W4), `inventory.write`.
 * - `POST /returns/:id/discard` → convenience discard (W4), `inventory.write`.
 * - `GET /technicians/:id/stock` → read-only technician stock (W5a), `inventory.read`.
 * - `POST /technicians/:id/issue` → issue (TRANSFER) stock depot→technician (W5a), `inventory.write`.
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

  return router;
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
