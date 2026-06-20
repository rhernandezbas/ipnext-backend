import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { SetVendedorMapping } from '@application/use-cases/SetVendedorMapping';
import { ListVendedorMappings } from '@application/use-cases/ListVendedorMappings';
import { ListDistinctVendedores } from '@application/use-cases/ListDistinctVendedores';
import {
  patchVendedorMappingSchema,
  toVendedorMappingItemDTO,
} from '@application/dto/vendedorMapping.dto';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';

/**
 * Admin routes for the agente↔vendedor (GR) mapping (Fase 2b, cartera "Mis clientes").
 *
 *   GET   /vendedor-mappings          — list all users + their GR vendedor (gate: recapture.assign)
 *   PATCH /vendedor-mappings/:userId  — set/clear mapping (gate: recapture.assign)
 *   GET   /vendedores                 — distinct GR vendedor catalog (gate: recapture.assign)
 *
 * Mount at /api/admin/gr.
 *
 * SECURITY: this is a cross-agent administration surface. All three routes are
 * gated on recapture.assign (the ADMIN marker), NOT recapture.manage — the agente
 * now has manage (to gestionar sus propios leads), so gating on manage would let
 * an agente list/mutate ANY user's mapping.
 *
 * Isolated from the core RbacUser modal on purpose: GR is slated for
 * deprecation, so the whole integration must be deletable without touching the
 * núcleo. Storage (RbacUser.grVendedorName) stays; the management lives here.
 */
export function createGrVendedorMappingsRouter(
  listMappings: ListVendedorMappings,
  setMapping: SetVendedorMapping,
  listVendedores: ListDistinctVendedores,
  authProvider: AuthProvider,
  requireRecaptureAssign: RequestHandler,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // GET /vendedor-mappings — list all mappings (recapture.assign)
  router.get('/vendedor-mappings', auth, requireRecaptureAssign, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rows = await listMappings.execute();
      res.status(200).json({ items: rows.map(toVendedorMappingItemDTO) });
    } catch (err) {
      next(err);
    }
  });

  // GET /vendedores — distinct GR vendedor catalog for the FE dropdown (recapture.assign)
  router.get('/vendedores', auth, requireRecaptureAssign, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const items = await listVendedores.execute();
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /vendedor-mappings/:userId — set/clear vendedor mapping (recapture.assign)
  router.patch('/vendedor-mappings/:userId', auth, requireRecaptureAssign, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parseResult = patchVendedorMappingSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', details: parseResult.error.flatten() });
        return;
      }

      const { grVendedorName } = parseResult.data;
      const { userId } = req.params;

      const updated = await setMapping.execute({ userId: userId!, grVendedorName });

      const dto = toVendedorMappingItemDTO({
        userId: updated.id,
        userName: updated.name,
        userLogin: updated.login,
        grVendedorName: updated.grVendedorName ?? null,
      });

      res.status(200).json(dto);
    } catch (err) {
      if (err instanceof ReferenceNotFoundError) {
        res.status(404).json({ error: err.message, code: 'USER_NOT_FOUND' });
        return;
      }
      next(err);
    }
  });

  return router;
}
