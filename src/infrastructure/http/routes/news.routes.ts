import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';

import { ListNewsPosts } from '@application/use-cases/ListNewsPosts';
import { GetNewsPost } from '@application/use-cases/GetNewsPost';
import { CreateNewsPost } from '@application/use-cases/CreateNewsPost';
import { UpdateNewsPost } from '@application/use-cases/UpdateNewsPost';
import { ArchiveNewsPost } from '@application/use-cases/ArchiveNewsPost';
import { MarkNewsRead } from '@application/use-cases/MarkNewsRead';
import { GetNewsUnreadCount } from '@application/use-cases/GetNewsUnreadCount';
import { ListNewsCategories } from '@application/use-cases/ListNewsCategories';
import { CreateNewsCategory } from '@application/use-cases/CreateNewsCategory';
import { UpdateNewsCategory } from '@application/use-cases/UpdateNewsCategory';
import { DeleteNewsCategory } from '@application/use-cases/DeleteNewsCategory';

import {
  CreateNewsPostSchema,
  UpdateNewsPostSchema,
  ArchiveNewsPostSchema,
  CreateNewsCategorySchema,
  UpdateNewsCategorySchema,
} from '@application/dto/news.dto';

import {
  NewsPostNotFoundError,
  NewsCategoryNotFoundError,
  NewsCategoryNameConflictError,
  NewsCategoryInUseError,
} from '@domain/errors/news';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

/**
 * `/api/news` — factory calco de `createTicketAreasRouter`. Every route carries
 * BOTH auth + requirePerm (design §6.1 — a deliberate contrast with
 * `/api/notifications`, which is mounted without guards). Static paths
 * (`/unread-count`, `/categories*`) are declared BEFORE `/:id` so the catch-all
 * param route never swallows them.
 */
export function createNewsRouter(
  authProvider: AuthProvider,
  requirePerm: RequirePerm,
  listNewsPosts: ListNewsPosts,
  getNewsPost: GetNewsPost,
  createNewsPost: CreateNewsPost,
  updateNewsPost: UpdateNewsPost,
  archiveNewsPost: ArchiveNewsPost,
  markNewsRead: MarkNewsRead,
  getNewsUnreadCount: GetNewsUnreadCount,
  listNewsCategories: ListNewsCategories,
  createNewsCategory: CreateNewsCategory,
  updateNewsCategory: UpdateNewsCategory,
  deleteNewsCategory: DeleteNewsCategory,
): Router {
  const router = Router();
  const auth       = createAuthMiddleware(authProvider);
  const readPerm   = requirePerm('news', 'read');
  const managePerm = requirePerm('news', 'manage');

  // ─── GET / — list (?category=<id> ?unread=true ?archived=true) ───────────────
  router.get('/', auth, readPerm, (req: Request, res: Response, next: NextFunction): void => {
    const runList = async (): Promise<void> => {
      try {
        const categoryId = typeof req.query['category'] === 'string' ? req.query['category'] : undefined;
        const archived = req.query['archived'] === 'true';
        const result = await listNewsPosts.execute({ categoryId, archived }, req.user!.id);
        const items = req.query['unread'] === 'true' ? result.items.filter((i) => !i.read) : result.items;
        res.json({ items, unreadCount: result.unreadCount });
      } catch (err) {
        next(err);
      }
    };

    if (req.query['archived'] === 'true') {
      // NEWS-HTTP-1: ?archived=true requires news.manage even though the base
      // route only needs news.read. Reuse the manage guard as a plain callable —
      // on success it invokes `next` (here: runList), on failure it 403s itself.
      managePerm(req, res, (() => { void runList(); }) as NextFunction);
      return;
    }
    void runList();
  });

  // GET /unread-count — the cheap badge endpoint. MUST precede /:id.
  router.get('/unread-count', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const count = await getNewsUnreadCount.execute(req.user!.id);
      res.json({ count });
    } catch (err) {
      next(err);
    }
  });

  // ─── Categories — MUST precede /:id ────────────────────────────────────────────
  router.get('/categories', auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await listNewsCategories.execute());
    } catch (err) {
      next(err);
    }
  });

  router.post('/categories', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateNewsCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.status(201).json(await createNewsCategory.execute(parsed.data));
    } catch (err) {
      if (err instanceof NewsCategoryNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      // Express 4: un throw async no llega al errorHandler — la request cuelga. Fallback SIEMPRE via next().
      next(err);
    }
  });

  router.put('/categories/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateNewsCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateNewsCategory.execute(req.params['id'] as string, parsed.data));
    } catch (err) {
      if (err instanceof NewsCategoryNotFoundError) {
        // Category CRUD context → 404 (design §5.3; contrast with the 422 used
        // when categoryId is referenced from a post create/update below).
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof NewsCategoryNameConflictError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  router.delete('/categories/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteNewsCategory.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof NewsCategoryNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof NewsCategoryInUseError) {
        res.status(409).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // ─── POST / — create post ──────────────────────────────────────────────────────
  router.post('/', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateNewsPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const dto = await createNewsPost.execute({
        ...parsed.data,
        // #48-style stamp from the session (tickets.routes.ts:507 molde).
        authorId: req.user?.id ?? null,
        authorName: req.user?.username ?? 'Sistema',
      });
      res.status(201).json(dto);
    } catch (err) {
      if (err instanceof NewsCategoryNotFoundError) {
        // Post create/update context → 422 (well-formed request, dangling reference;
        // molde de la validación up-front del reporterId, tickets.routes.ts:460-466).
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // ─── /:id routes — declared LAST (catch-all param) ─────────────────────────────
  router.get('/:id', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getNewsPost.execute(req.params['id'] as string, req.user!.id));
    } catch (err) {
      if (err instanceof NewsPostNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  router.put('/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateNewsPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await updateNewsPost.execute(req.params['id'] as string, parsed.data));
    } catch (err) {
      if (err instanceof NewsPostNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof NewsCategoryNotFoundError) {
        res.status(422).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  router.put('/:id/archive', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = ArchiveNewsPostSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      res.json(await archiveNewsPost.execute(req.params['id'] as string, parsed.data.archived));
    } catch (err) {
      if (err instanceof NewsPostNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  router.post('/:id/read', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await markNewsRead.execute(req.params['id'] as string, req.user!.id);
      res.status(204).send();
    } catch (err) {
      if (err instanceof NewsPostNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  return router;
}
