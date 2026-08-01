import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import { SyncIClassSoTypes } from '@application/use-cases/SyncIClassSoTypes';
import { ListIClassSoTypes } from '@application/use-cases/ListIClassSoTypes';
import { SyncIClassNodes } from '@application/use-cases/SyncIClassNodes';
import { ListIClassNodeCatalog } from '@application/use-cases/ListIClassNodeCatalog';

const ListSoTypesQuerySchema = z.object({
  active: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => (v === 'true' ? true : v === 'false' ? false : undefined)),
});

const BoolQueryFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform(v => (v === 'true' ? true : v === 'false' ? false : undefined));

const ListNodesQuerySchema = z.object({
  active: BoolQueryFlag,
  selectable: BoolQueryFlag,
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
 * nodes-city-mapper (#45): when the node use cases are provided, also exposes
 * POST /nodes/sync and GET /nodes (REQ-NCAT-1, REQ-NCAT-2). Optional params keep
 * the existing 3-arg call sites valid.
 *
 * Decision (FASE 4): the sync endpoint returns all 5 fields from SyncSummary
 * ({ synced, created, updated, reactivated, deactivated }) rather than just
 * { synced, deactivated }. More info is harmless and the FE can pick what to show.
 */
export function createIClassAdminRouter(
  syncIClassSoTypes: SyncIClassSoTypes,
  listIClassSoTypes: ListIClassSoTypes,
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  syncIClassNodes?: SyncIClassNodes,
  listIClassNodeCatalog?: ListIClassNodeCatalog,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);

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
  router.get('/so-types', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
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
    } catch (err) {
      next(err);
    }
  });

  // ── IClass node catalog (nodes-city-mapper #45) ──────────────────────────────
  if (syncIClassNodes && listIClassNodeCatalog) {
    // POST /nodes/sync
    router.post('/nodes/sync', auth, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await syncIClassNodes.execute();
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    });

    // GET /nodes
    router.get('/nodes', auth, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const parsed = ListNodesQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
          return;
        }

        const filter: { active?: boolean; selectable?: boolean } = {};
        if (parsed.data.active !== undefined) filter.active = parsed.data.active;
        if (parsed.data.selectable !== undefined) filter.selectable = parsed.data.selectable;
        const nodes = await listIClassNodeCatalog.execute(
          Object.keys(filter).length > 0 ? filter : undefined,
        );

        // Wire shape (REQ-NCAT-2): dates → ISO strings.
        const items = nodes.map(n => ({
          id: n.id,
          nodeId: n.nodeId,
          code: n.code,
          description: n.description,
          active: n.active,
          selectable: n.selectable,
          lastSyncedAt: n.lastSyncedAt instanceof Date ? n.lastSyncedAt.toISOString() : n.lastSyncedAt,
          createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : n.createdAt,
          updatedAt: n.updatedAt instanceof Date ? n.updatedAt.toISOString() : n.updatedAt,
        }));

        res.status(200).json({ items });
      } catch (err) {
        next(err);
      }
    });
  }

  return router;
}
