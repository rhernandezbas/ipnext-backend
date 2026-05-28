import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { SyncIClassSoTypes } from '@application/use-cases/SyncIClassSoTypes';
import { ListIClassSoTypes } from '@application/use-cases/ListIClassSoTypes';

const ListSoTypesQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => (v === 'true' ? true : v === 'false' ? false : undefined)),
});

/**
 * Admin routes for the IClass SO type catalog.
 *
 * POST /so-types/sync   — manually sync the catalog from IClass (REQ-HTTP-SYNC-1).
 * GET  /so-types        — list the catalog, optionally filtered by active (REQ-HTTP-LIST-1).
 *
 * Both routes require admin auth (REQ-HTTP-SYNC-2, REQ-HTTP-LIST-2).
 * Mount at /api/admin/iclass in app.ts.
 *
 * Decision (FASE 4): the sync endpoint returns all 5 fields from SyncSummary
 * ({ synced, created, updated, reactivated, deactivated }) rather than just
 * { synced, deactivated }. More info is harmless and the FE can pick what to show.
 */
export function createIClassAdminRouter(
  syncIClassSoTypes: SyncIClassSoTypes,
  listIClassSoTypes: ListIClassSoTypes,
  authProvider: AuthProvider,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // POST /so-types/sync
  router.post('/so-types/sync', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await syncIClassSoTypes.execute();
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /so-types
  router.get('/so-types', auth, async (req: Request, res: Response): Promise<void> => {
    const parsed = ListSoTypesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }

    const filter = parsed.data.active !== undefined ? { active: parsed.data.active } : undefined;
    const types = await listIClassSoTypes.execute(filter);

    // Map to response shape: dates → ISO strings (REQ-SHAPE-CAT-1)
    const items = types.map(t => ({
      id: t.id,
      code: t.code,
      description: t.description,
      active: t.active,
      lastSyncedAt: t.lastSyncedAt instanceof Date ? t.lastSyncedAt.toISOString() : t.lastSyncedAt,
      createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
      updatedAt: t.updatedAt instanceof Date ? t.updatedAt.toISOString() : t.updatedAt,
    }));

    res.status(200).json({ items });
  });

  return router;
}
