import { z } from 'zod';
import type { StoreProduct } from '@domain/entities/storeProduct';

// ─── Admin DTO ───────────────────────────────────────────────────────────────

/** Admin CRUD — TODOS los campos (a diferencia del DTO client-facing del
 * portal, que solo expone lo que el cliente necesita ver + installmentArs
 * calculado). */
export interface StoreProductAdminDto {
  id: string;
  title: string;
  summary: string;
  description: string;
  priceArs: number;
  maxInstallments: number;
  warrantyText: string;
  badge: string | null;
  imageStorageKey: string | null;
  ticketAreaId: string | null;
  active: boolean;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toStoreProductAdminDto(product: StoreProduct): StoreProductAdminDto {
  return { ...product };
}

// ─── Create/Update schemas ───────────────────────────────────────────────────
// `imageStorageKey` NO se acepta acá A PROPÓSITO (mismo criterio que
// `PortalPromoFieldsSchema` en promos.dto.ts) — la key SOLO la produce el
// endpoint dedicado de subida (`POST /api/store/products/:id/image`, magic
// bytes + MinIO). A diferencia de promos, ACÁ la rebanada de imagen SÍ está
// completa (upload + serve, ver store.routes.ts / portal.routes.ts), así que
// el campo se setea vía ese endpoint, nunca por JSON plano.

const DateInputSchema = z
  .union([z.string(), z.date()])
  .transform((v) => new Date(v))
  .refine((d) => !Number.isNaN(d.getTime()), { message: 'fecha inválida' });

const StoreProductFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1).max(20000),
  priceArs: z.number().finite().positive(),
  // Ausente = 1 (solo un pago).
  maxInstallments: z.number().int().min(1).max(24).optional(),
  warrantyText: z.string().trim().min(1).max(2000),
  badge: z.string().trim().min(1).max(60).nullish(),
  ticketAreaId: z.string().min(1).nullish(),
  // Ausente = false (borrador — lado seguro).
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const CreateStoreProductSchema = StoreProductFieldsSchema;
export type CreateStoreProductInput = z.infer<typeof CreateStoreProductSchema>;

// `undefined` = no tocar; `null`/valor = setear. `archivedAt` solo en el
// patch (archivar/desarchivar) — nunca en el create.
export const UpdateStoreProductSchema = StoreProductFieldsSchema.partial().extend({
  archivedAt: DateInputSchema.nullish(),
});
export type UpdateStoreProductInput = z.infer<typeof UpdateStoreProductSchema>;
