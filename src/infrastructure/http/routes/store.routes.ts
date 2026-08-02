import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import { AuthProvider } from '@domain/ports/AuthProvider';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import type { SessionRepository } from '@domain/ports/SessionRepository';

import { ListStoreProductsAdmin } from '@application/use-cases/store/ListStoreProductsAdmin';
import { GetStoreProductAdmin } from '@application/use-cases/store/GetStoreProductAdmin';
import { CreateStoreProduct } from '@application/use-cases/store/CreateStoreProduct';
import { UpdateStoreProduct } from '@application/use-cases/store/UpdateStoreProduct';
import { UploadStoreProductImage } from '@application/use-cases/store/UploadStoreProductImage';
import { DeleteStoreProductImage } from '@application/use-cases/store/DeleteStoreProductImage';
import { GetStoreProductImage } from '@application/use-cases/store/GetStoreProductImage';
import { ListStoreOrdersAdmin } from '@application/use-cases/store/ListStoreOrdersAdmin';

import { CreateStoreProductSchema, UpdateStoreProductSchema } from '@application/dto/storeProducts.dto';
import {
  StoreProductNotFoundError,
  StoreProductValidationError,
  UnsupportedStoreProductImageTypeError,
  StoreProductImageTooLargeError,
} from '@domain/errors/storeProduct.errors';
import { MAX_IMAGE_BYTES } from '@application/use-cases/ticketMessageAttachments';

/** Factory matching `requirePerm` exported from app.ts (DIP-clean injection). */
type RequirePerm = (module: RbacModuleCode, action: PermissionAction) => RequestHandler;

const IMAGE_FIELD = 'file';

/**
 * `/api/store` — factory calco de `createPromosRouter`. Auth + `requirePerm`
 * en TODAS las rutas — `store.read` para lectura (catálogo + pedidos),
 * `store.manage` para create/update/imagen.
 *
 * Contrato HTTP:
 *  - GET    /products          (read)    -> {data: StoreProductAdminDto[]} (TODOS, incl. borrador/archivado)
 *  - POST   /products          (manage)  -> 201 StoreProductAdminDto
 *  - GET    /products/:id      (read)    -> StoreProductAdminDto (404)
 *  - PATCH  /products/:id      (manage)  -> StoreProductAdminDto (partial; archivar = archivedAt)
 *  - POST   /products/:id/image (manage) multipart 'file' -> 200 StoreProductAdminDto (magic bytes, cap 8MB)
 *  - GET    /products/:id/image (read)    -> binario inline (thumbnail para el panel — SIN re-chequeo de active/archivedAt, a diferencia de la ruta del portal)
 *  - DELETE /products/:id/image (manage) -> 204 (idempotente sobre la imagen; 404 si el producto no existe)
 *  - GET    /orders            (read)    -> {data: StoreOrderAdminDto[]} (incluye ticketId (UUID) Y ticketNumber (display) para el link del panel)
 */
export function createStoreRouter(
  authProvider: AuthProvider,
  sessionRepo: SessionRepository | undefined,
  requirePerm: RequirePerm,
  listStoreProductsAdmin: ListStoreProductsAdmin,
  getStoreProductAdmin: GetStoreProductAdmin,
  createStoreProduct: CreateStoreProduct,
  updateStoreProduct: UpdateStoreProduct,
  uploadStoreProductImage: UploadStoreProductImage,
  deleteStoreProductImage: DeleteStoreProductImage,
  listStoreOrdersAdmin: ListStoreOrdersAdmin,
  getStoreProductImage: GetStoreProductImage,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider, sessionRepo);
  const readPerm = requirePerm('store', 'read');
  const managePerm = requirePerm('store', 'manage');

  // Tope grueso de multer (mismo MAX_IMAGE_BYTES que el pipeline de
  // mensajería reusado) — el chequeo FINO de tipo real (magic bytes) corre
  // en `validateStoreProductImage`, capa de aplicación.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  });
  const uploadImage: RequestHandler = (req, res, next) => {
    upload.single(IMAGE_FIELD)(req, res, (err: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            error: `El archivo excede el límite de ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))}MB`,
            code: 'FILE_TOO_LARGE',
          });
          return;
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          res.status(400).json({ error: `El archivo debe ir en el campo "${IMAGE_FIELD}"`, code: 'UNEXPECTED_FIELD' });
          return;
        }
        res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
        return;
      }
      next(err);
    });
  };

  router.get('/orders', auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json({ data: await listStoreOrdersAdmin.execute() });
    } catch (err) {
      next(err);
    }
  });

  router.get('/products', auth, readPerm, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json({ data: await listStoreProductsAdmin.execute() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/products', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = CreateStoreProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const dto = await createStoreProduct.execute(parsed.data);
      res.status(201).json(dto);
    } catch (err) {
      if (err instanceof StoreProductValidationError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  // ─── /products/:id routes — declaradas DESPUÉS de las estáticas ────────────
  router.get('/products/:id', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await getStoreProductAdmin.execute(req.params['id'] as string));
    } catch (err) {
      if (err instanceof StoreProductNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  router.patch('/products/:id', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = UpdateStoreProductSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', code: 'VALIDATION_ERROR', details: parsed.error.issues });
      return;
    }
    try {
      const dto = await updateStoreProduct.execute(req.params['id'] as string, parsed.data);
      res.json(dto);
    } catch (err) {
      if (err instanceof StoreProductNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      if (err instanceof StoreProductValidationError) {
        res.status(400).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  router.post(
    '/products/:id/image',
    auth,
    managePerm,
    uploadImage,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        res.status(400).json({ error: `No se subió ningún archivo bajo el campo "${IMAGE_FIELD}"`, code: 'NO_FILE' });
        return;
      }
      try {
        const dto = await uploadStoreProductImage.execute(req.params['id'] as string, {
          buffer: file.buffer,
          mimeType: file.mimetype,
        });
        res.status(200).json(dto);
      } catch (err) {
        if (err instanceof StoreProductNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof UnsupportedStoreProductImageTypeError) {
          res.status(415).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof StoreProductImageTooLargeError) {
          res.status(413).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    },
  );

  // GET /products/:id/image (store.read) — thumbnail para el panel. SIN
  // re-chequeo de elegibilidad (a diferencia de la ruta del portal): el
  // staff necesita ver la imagen de un producto en borrador/archivado
  // mientras lo edita, mismo criterio que `GetStoreProductAdmin`.
  router.get('/products/:id/image', auth, readPerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const file = await getStoreProductImage.execute(req.params['id'] as string);
      if (!file) {
        res.status(404).json({ error: 'Store product image not found', code: 'STORE_PRODUCT_NOT_FOUND' });
        return;
      }
      res.setHeader('Content-Type', file.mimeType);
      res.send(file.buffer);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/products/:id/image', auth, managePerm, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await deleteStoreProductImage.execute(req.params['id'] as string);
      res.status(204).send();
    } catch (err) {
      if (err instanceof StoreProductNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  return router;
}
